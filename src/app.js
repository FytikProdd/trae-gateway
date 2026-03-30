const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { buildAgentTaskPayload } = require("./agent-task-builder");
const { ModelDiscovery } = require("./model-discovery");
const { SessionStore, deriveConversationKey } = require("./session-store");
const { compactContentParts, extractTraeEventDelta, iterateSseEvents } = require("./sse");
const {
  buildCommitToolPayload,
  isToolResultRequest,
  mergePendingToolCalls,
} = require("./tool-call-loop");
const { TraeClient } = require("./trae-client");
const {
  createObjectId,
  createRequestId,
  createTraceId,
  deepReplace,
  flattenMessages,
  json,
  parseJson,
  sanitizeAuthInfo,
  sseHeaders,
  toUnixSeconds,
} = require("./utils");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function createConfig(env = process.env, cwd = process.cwd()) {
  return {
    cwd,
    port: Number(env.PORT || 4317),
    debug: String(env.TRAE_DEBUG || "true").toLowerCase() !== "false",
    mode: env.TRAE_PROXY_MODE || "agent-v3-auto",
    agentTemplatePath: resolveIfSet(env.TRAE_AGENT_TEMPLATE_PATH, cwd),
    rawChatTemplatePath: resolveIfSet(env.TRAE_RAW_CHAT_TEMPLATE_PATH, cwd),
    storagePath: resolveIfSet(env.TRAE_STORAGE_PATH, cwd),
    productPath: resolveIfSet(env.TRAE_PRODUCT_PATH, cwd),
    sessionStorePath:
      resolveIfSet(env.TRAE_SESSION_STORE_PATH, cwd)
      || path.resolve(cwd, ".trae-gateway-sessions.json"),
    requestTimeoutMs: Number(env.TRAE_REQUEST_TIMEOUT_MS || 120000),
  };
}

function createGateway(config = createConfig()) {
  const trae = new TraeClient({
    storagePath: config.storagePath,
    productPath: config.productPath,
    debug: config.debug,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  const sessionStore = new SessionStore({ filePath: config.sessionStorePath });
  const modelDiscovery = new ModelDiscovery({});

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          ok: true,
          mode: config.mode,
          baseDomain: trae.getBaseDomain("agent"),
        });
      }

      if (request.method === "GET" && url.pathname === "/debug/auth") {
        return json(response, 200, {
          ok: true,
          baseDomain: trae.getBaseDomain("agent"),
          auth: sanitizeAuthInfo(trae.readAuth()),
        });
      }

      if (request.method === "GET" && url.pathname === "/debug/detail-param") {
        const functionName = url.searchParams.get("function") || "chat_v3";
        const result = await trae.getDetailParam(functionName);
        return json(response, result.status, {
          ok: result.ok,
          url: result.url,
          data: result.data,
          text: result.data ? undefined : result.text,
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(response, 200, {
          object: "list",
          data: modelDiscovery.discover(),
        });
      }

      if (request.method === "POST" && url.pathname === "/debug/agent/v3/create_agent_task") {
        const body = await readJsonBody(request);
        return proxyRawSse(response, await trae.createAgentTask(body));
      }

      if (request.method === "POST" && url.pathname === "/debug/agent/v3/commit_toolcall_result") {
        const body = await readJsonBody(request);
        return proxyRawSse(response, await trae.commitToolcallResult(body));
      }

      if (request.method === "POST" && url.pathname === "/debug/ide/v2/llm_raw_chat") {
        const body = await readJsonBody(request);
        return proxyRawSse(response, await trae.llmRawChat(body));
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const openaiRequest = await readJsonBody(request);
        return handleOpenAiChat({
          response,
          openaiRequest,
          requestHeaders: request.headers,
          config,
          trae,
          sessionStore,
        });
      }

      return json(response, 404, {
        error: {
          message: `Unknown route: ${request.method} ${url.pathname}`,
          type: "not_found",
        },
      });
    } catch (error) {
      return json(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "internal_error",
        },
      });
    }
  });

  return { server, trae };
}

async function handleOpenAiChat({
  response,
  openaiRequest,
  requestHeaders,
  config,
  trae,
  sessionStore,
}) {
  const stream = openaiRequest.stream === true;
  const model = openaiRequest.model || "trae-agent";
  const continuationRequest = isToolResultRequest(openaiRequest.messages);
  const prompt = continuationRequest ? "" : flattenMessages(openaiRequest.messages);

  if (!continuationRequest && !prompt.trim()) {
    return json(response, 400, {
      error: {
        message: "Request does not contain any usable text messages.",
        type: "invalid_request_error",
      },
    });
  }

  const authState = trae.getAuthState();
  if (!authState.ok) {
    return json(response, 401, {
      error: {
        message: authState.message,
        type: "authentication_error",
      },
    });
  }

  const conversationKey = deriveConversationKey(openaiRequest, normalizeHeaders(requestHeaders));
  const conversation = conversationKey
    ? sessionStore.ensureConversation(conversationKey, () => ({
        session_id: createObjectId(),
        conversation_id: createObjectId(),
        turn_count: 0,
      }))
    : null;

  if (continuationRequest && !conversationKey) {
    return json(response, 400, {
      error: {
        message:
          "Tool result continuation requires a stable conversation key via metadata, headers, or user.",
        type: "invalid_request_error",
      },
    });
  }

  const runtimeVars = {
    prompt,
    model,
    session_id: conversation?.session_id || createObjectId(),
    task_id: createObjectId(),
    message_id: createObjectId(),
    trace_id: createTraceId(),
    request_id: createRequestId(),
  };

  let result;
  if (continuationRequest) {
    let commitPayload;
    try {
      commitPayload = buildCommitToolPayload({
        conversation,
        openaiRequest,
      });
    } catch (error) {
      return json(response, 409, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "invalid_request_error",
        },
      });
    }

    result = await trae.commitToolcallResult(commitPayload);
  } else if (config.mode === "agent-v3-auto") {
    result = await trae.createAgentTask(
      buildAgentTaskPayload({
        openaiRequest,
        runtimeVars,
        prompt,
        model,
      }),
    );
  } else if (config.mode === "agent-v3-template") {
    if (!config.agentTemplatePath || !fs.existsSync(config.agentTemplatePath)) {
      return json(
        response,
        501,
        missingTemplateError("TRAE_AGENT_TEMPLATE_PATH", "/api/agent/v3/create_agent_task"),
      );
    }
    result = await trae.createAgentTask(buildTemplatePayload(config.agentTemplatePath, runtimeVars));
  } else if (config.mode === "raw-chat-template") {
    if (!config.rawChatTemplatePath || !fs.existsSync(config.rawChatTemplatePath)) {
      return json(
        response,
        501,
        missingTemplateError("TRAE_RAW_CHAT_TEMPLATE_PATH", "/api/ide/v2/llm_raw_chat"),
      );
    }
    result = await trae.llmRawChat(buildTemplatePayload(config.rawChatTemplatePath, runtimeVars));
  } else {
    return json(response, 500, {
      error: {
        message: `Unsupported mode: ${config.mode}`,
        type: "configuration_error",
      },
    });
  }

  const persistConversation = (state) => {
    if (!conversationKey) {
      return;
    }

    const ids = state?.ids || {};
    sessionStore.upsertConversation(conversationKey, {
      session_id: ids.session_id || conversation?.session_id || runtimeVars.session_id,
      conversation_id:
        ids.conversation_id
        || conversation?.conversation_id
        || conversation?.session_id
        || runtimeVars.session_id,
      last_task_id: ids.task_id || conversation?.last_task_id || runtimeVars.task_id,
      last_message_id:
        ids.message_id || conversation?.last_message_id || runtimeVars.message_id,
      turn_count: Number(conversation?.turn_count || 0) + 1,
      model,
      user_id:
        typeof openaiRequest.user === "string" && openaiRequest.user.trim()
          ? openaiRequest.user.trim()
          : conversation?.user_id || "",
      pending_tool_calls: state?.pendingToolCalls || [],
    });
  };

  if (stream) {
    return proxyTraeSseAsOpenAi(response, result, model, persistConversation);
  }

  return proxyTraeSseAsOpenAiJson(response, result, model, persistConversation);
}

function buildTemplatePayload(templatePath, runtimeVars) {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  return deepReplace(template, runtimeVars);
}

function missingTemplateError(envName, endpoint) {
  return {
    error: {
      message: `Gateway is running, but ${envName} is not configured. Capture one real Trae payload for ${endpoint}, save it as JSON, replace changing fields with placeholders, and set ${envName}.`,
      type: "not_implemented",
    },
  };
}

async function readJsonBody(request) {
  const raw = await readTextBody(request);
  return raw ? JSON.parse(raw) : {};
}

async function readTextBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function proxyRawSse(response, traeResult) {
  if (!traeResult.ok || !traeResult.body) {
    return writeMappedUpstreamError(response, traeResult);
  }

  response.writeHead(200, sseHeaders());
  for await (const chunk of traeResult.body) {
    response.write(chunk);
  }
  response.end();
}

async function proxyTraeSseAsOpenAiJson(response, traeResult, model, persistConversation) {
  if (!traeResult.ok || !traeResult.body) {
    return writeMappedUpstreamError(response, traeResult);
  }

  const aggregate = await collectTraeResponse(traeResult.body);
  persistConversation?.(aggregate);

  const message = {
    role: "assistant",
    content: aggregate.content || "",
  };

  if (aggregate.toolCalls.length > 0) {
    message.tool_calls = aggregate.toolCalls;
  }

  return json(response, 200, {
    id: `chatcmpl-${createObjectId()}`,
    object: "chat.completion",
    created: toUnixSeconds(),
    model,
    choices: [
      {
        index: 0,
        finish_reason: aggregate.toolCalls.length > 0 ? "tool_calls" : aggregate.finishReason || "stop",
        message,
      },
    ],
    usage: emptyUsage(),
  });
}

async function proxyTraeSseAsOpenAi(response, traeResult, model, persistConversation) {
  if (!traeResult.ok || !traeResult.body) {
    return writeMappedUpstreamError(response, traeResult);
  }

  response.writeHead(200, sseHeaders());

  const created = toUnixSeconds();
  const completionId = `chatcmpl-${createObjectId()}`;
  let emittedToolCalls = false;
  let lastTextDelta = null;
  let toolCallIndex = 0;
  const aggregateState = {
    ids: {},
    pendingToolCalls: [],
  };

  for await (const event of iterateSseEvents(traeResult.body)) {
    const delta = extractTraeEventDelta(event.data);
    Object.assign(aggregateState.ids, delta.ids);
    aggregateState.pendingToolCalls = mergePendingToolCalls(
      aggregateState.pendingToolCalls,
      delta.toolCallContexts,
    );

    for (const toolCall of delta.toolCalls) {
      emittedToolCalls = true;
      response.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex++,
                    id: toolCall.id || undefined,
                    type: "function",
                    function: toolCall.function,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }

    for (const textPart of compactContentParts(delta.contentParts)) {
      if (textPart === lastTextDelta) {
        continue;
      }

      lastTextDelta = textPart;
      response.write(
        `data: ${JSON.stringify({
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: textPart },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }
  }

  persistConversation?.(aggregateState);
  response.write(
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: emittedToolCalls ? "tool_calls" : "stop",
        },
      ],
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

async function collectTraeResponse(stream) {
  const contentParts = [];
  const toolCalls = [];
  let pendingToolCalls = [];
  const seenToolCalls = new Set();
  const ids = {};
  let finishReason = null;

  for await (const event of iterateSseEvents(stream)) {
    const delta = extractTraeEventDelta(event.data);
    contentParts.push(...delta.contentParts);
    Object.assign(ids, delta.ids);
    finishReason ||= delta.finishReason;
    pendingToolCalls = mergePendingToolCalls(pendingToolCalls, delta.toolCallContexts);

    for (const toolCall of delta.toolCalls) {
      const key = `${toolCall.id || ""}:${toolCall.function?.name || ""}`;
      if (seenToolCalls.has(key)) {
        continue;
      }
      seenToolCalls.add(key);
      toolCalls.push(toolCall);
    }
  }

  return {
    content: compactContentParts(contentParts).join("\n"),
    toolCalls,
    pendingToolCalls,
    ids,
    finishReason,
  };
}

function writeMappedUpstreamError(response, traeResult) {
  const error = mapUpstreamError(traeResult);
  return json(response, error.status, {
    error: {
      message: error.message,
      type: error.type,
    },
  });
}

function mapUpstreamError(traeResult) {
  if (traeResult.errorCode === "ETIMEDOUT") {
    return {
      status: 504,
      type: "timeout_error",
      message: "Trae upstream timed out before returning a response.",
    };
  }

  const bodyText = typeof traeResult.text === "string" ? traeResult.text : "";
  const parsed = parseJson(bodyText, null);
  const message = parsed?.error?.message || parsed?.message || bodyText || `Trae upstream returned ${traeResult.status}`;

  if (traeResult.status === 401 || traeResult.status === 403) {
    return { status: traeResult.status, type: "authentication_error", message };
  }

  if (traeResult.status === 429) {
    return { status: 429, type: "rate_limit_error", message };
  }

  if (traeResult.status === 408) {
    return { status: 504, type: "timeout_error", message };
  }

  if (traeResult.status >= 500) {
    return { status: 502, type: "server_error", message };
  }

  if (traeResult.status >= 400) {
    return { status: traeResult.status, type: "invalid_request_error", message };
  }

  return { status: 502, type: "upstream_error", message };
}

function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function resolveIfSet(value, cwd) {
  if (!value) {
    return null;
  }

  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

module.exports = {
  createConfig,
  createGateway,
  loadDotEnv,
  mapUpstreamError,
};
