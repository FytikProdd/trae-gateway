const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const { buildAgentTaskPayload } = require("./agent-task-builder");
const { TraeClient } = require("./trae-client");
const {
  createObjectId,
  createRequestId,
  createTraceId,
  deepReplace,
  extractTextFromTraeEvent,
  flattenMessages,
  json,
  parseJson,
  sanitizeAuthInfo,
  sseHeaders,
  text,
} = require("./utils");

loadDotEnv(path.resolve(process.cwd(), ".env"));

const PORT = Number(process.env.PORT || 4317);
const DEBUG = String(process.env.TRAE_DEBUG || "true").toLowerCase() !== "false";
const MODE = process.env.TRAE_PROXY_MODE || "agent-v3-auto";
const AGENT_TEMPLATE_PATH = resolveIfSet(process.env.TRAE_AGENT_TEMPLATE_PATH);
const RAW_CHAT_TEMPLATE_PATH = resolveIfSet(process.env.TRAE_RAW_CHAT_TEMPLATE_PATH);

const trae = new TraeClient({
  storagePath: resolveIfSet(process.env.TRAE_STORAGE_PATH),
  productPath: resolveIfSet(process.env.TRAE_PRODUCT_PATH),
  debug: DEBUG,
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, {
        ok: true,
        mode: MODE,
        baseDomain: trae.getBaseDomain(),
      });
    }

    if (request.method === "GET" && url.pathname === "/debug/auth") {
      return json(response, 200, {
        ok: true,
        baseDomain: trae.getBaseDomain(),
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
        data: [
          { id: "trae-agent", object: "model", owned_by: "trae" },
          { id: "trae-raw-chat", object: "model", owned_by: "trae" },
        ],
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
      return handleOpenAiChat(response, openaiRequest);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Trae gateway listening on http://127.0.0.1:${PORT}`);
  console.log(`Mode: ${MODE}`);
  try {
    console.log(`Trae base: ${trae.getBaseDomain()}`);
  } catch (error) {
    console.log(
      `Trae base: unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
});

function resolveIfSet(value) {
  if (!value) {
    return null;
  }

  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

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

async function handleOpenAiChat(response, openaiRequest) {
  const prompt = flattenMessages(openaiRequest.messages);
  const stream = openaiRequest.stream === true;
  const model = openaiRequest.model || "trae-agent";

  if (!prompt.trim()) {
    return json(response, 400, {
      error: {
        message: "Request does not contain any usable text messages.",
        type: "invalid_request_error",
      },
    });
  }

  const runtimeVars = {
    prompt,
    model,
    session_id: createObjectId(),
    task_id: createObjectId(),
    message_id: createObjectId(),
    trace_id: createTraceId(),
    request_id: createRequestId(),
  };

  if (MODE === "agent-v3-auto") {
    const payload = buildAgentTaskPayload({
      openaiRequest,
      runtimeVars,
      prompt,
      model,
    });
    const result = await trae.createAgentTask(payload);
    if (stream) {
      return proxyTraeSseAsOpenAi(response, result, model);
    }
    return proxyTraeSseAsOpenAiJson(response, result, model);
  }

  if (MODE === "agent-v3-template") {
    if (!AGENT_TEMPLATE_PATH || !fs.existsSync(AGENT_TEMPLATE_PATH)) {
      return json(
        response,
        501,
        missingTemplateError("TRAE_AGENT_TEMPLATE_PATH", "/api/agent/v3/create_agent_task"),
      );
    }

    const payload = buildTemplatePayload(AGENT_TEMPLATE_PATH, runtimeVars);
    const result = await trae.createAgentTask(payload);
    if (stream) {
      return proxyTraeSseAsOpenAi(response, result, model);
    }
    return proxyTraeSseAsOpenAiJson(response, result, model);
  }

  if (MODE === "raw-chat-template") {
    if (!RAW_CHAT_TEMPLATE_PATH || !fs.existsSync(RAW_CHAT_TEMPLATE_PATH)) {
      return json(response, 501, missingTemplateError("TRAE_RAW_CHAT_TEMPLATE_PATH", "/api/ide/v2/llm_raw_chat"));
    }

    const payload = buildTemplatePayload(RAW_CHAT_TEMPLATE_PATH, runtimeVars);
    const result = await trae.llmRawChat(payload);
    if (stream) {
      return proxyTraeSseAsOpenAi(response, result, model);
    }
    return proxyTraeSseAsOpenAiJson(response, result, model);
  }

  return json(response, 500, {
    error: {
      message: `Unsupported mode: ${MODE}`,
      type: "configuration_error",
    },
  });
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
    const rawText = traeResult.body ? await streamToString(traeResult.body) : "";
    return json(response, traeResult.status, {
      ok: false,
      url: traeResult.url,
      status: traeResult.status,
      text: rawText,
    });
  }

  response.writeHead(200, sseHeaders());
  for await (const chunk of traeResult.body) {
    response.write(chunk);
  }
  response.end();
}

async function proxyTraeSseAsOpenAiJson(response, traeResult, model) {
  if (!traeResult.ok || !traeResult.body) {
    const rawText = traeResult.body ? await streamToString(traeResult.body) : "";
    return json(response, traeResult.status, {
      error: {
        message: rawText || `Trae upstream returned ${traeResult.status}`,
        type: "upstream_error",
      },
    });
  }

  const contentParts = [];
  for await (const event of iterateSseEvents(traeResult.body)) {
    const textPart = extractTextFromTraeEvent(event.data);
    if (textPart) {
      contentParts.push(textPart);
    }
  }

  const content = dedupeJoinedContent(contentParts);
  return json(response, 200, {
    id: `chatcmpl-${createObjectId()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

async function proxyTraeSseAsOpenAi(response, traeResult, model) {
  if (!traeResult.ok || !traeResult.body) {
    const rawText = traeResult.body ? await streamToString(traeResult.body) : "";
    return json(response, traeResult.status, {
      error: {
        message: rawText || `Trae upstream returned ${traeResult.status}`,
        type: "upstream_error",
      },
    });
  }

  response.writeHead(200, sseHeaders());

  const created = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${createObjectId()}`;

  for await (const event of iterateSseEvents(traeResult.body)) {
    const textDelta = extractTextFromTraeEvent(event.data);
    if (!textDelta) {
      continue;
    }

    const payload = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: textDelta },
          finish_reason: null,
        },
      ],
    };

    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  response.write(
    `data: ${JSON.stringify({
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

async function* iterateSseEvents(stream) {
  let buffer = "";

  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString("utf8");

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex === -1) {
        break;
      }

      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const lines = rawEvent.split(/\r?\n/);
      let eventName = "message";
      const dataParts = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataParts.push(line.slice(5).trim());
        }
      }

      yield {
        event: eventName,
        data: dataParts.join("\n"),
      };
    }
  }
}

async function streamToString(stream) {
  let output = "";
  for await (const chunk of stream) {
    output += Buffer.from(chunk).toString("utf8");
  }
  return output;
}

function dedupeJoinedContent(parts) {
  const out = [];
  const seen = new Set();

  for (const part of parts) {
    const value = String(part).trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }

  return out.join("\n");
}
