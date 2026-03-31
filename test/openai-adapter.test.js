const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const { createGateway } = require("../src/app");

test("chat completions aggregates Trae SSE into a non-streaming OpenAI response", async (t) => {
  let capturedPayload = null;
  const sessionStore = createMemorySessionStore();
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            userId: "user-1",
            deviceId: "device-1",
            ideVersion: "3.5.42",
            pluginChannel: "stable",
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
            appLanguage: "en-US",
          };
        },
        async createAgentTask(payload) {
          capturedPayload = payload;
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              `data: ${JSON.stringify({
                session_id: "trae-session-1",
                conversation_id: "trae-conversation-1",
                task_id: "task-1",
                message_id: "message-1",
                content: "First answer",
              })}\n\n`,
              `data: ${JSON.stringify({
                tool_name: "search_codebase",
                toolcall_id: "tool-1",
                agent_run_id: "agent-run-1",
                arguments: { query: "gateway" },
              })}\n\n`,
              `data: ${JSON.stringify({
                content: "Second answer",
                finish_reason: "stop",
              })}\n\n`,
            ]),
          };
        },
      },
      sessionStore,
      modelDiscovery: {
        discover() {
          return [
            { id: "gpt-5.4", object: "model", owned_by: "trae", selected: true },
            { id: "gemini-3.1-pro", object: "model", owned_by: "trae" },
          ];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "trae-agent",
      user: "user-1",
      metadata: { conversation_id: "thread-123" },
      messages: [
        { role: "system", content: "You are precise." },
        { role: "user", content: "Summarize the gateway status." },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gpt-5.4");
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(body.choices[0].message, {
    role: "assistant",
    content: "First answer\nSecond answer",
    tool_calls: [
      {
        id: "tool-1",
        type: "function",
        function: {
          name: "search_codebase",
          arguments: '{"query":"gateway"}',
        },
      },
    ],
  });

  assert.equal(capturedPayload.model, "gpt-5.4");
  assert.equal(
    capturedPayload.query,
    "SYSTEM:\nYou are precise.\n\nUSER:\nSummarize the gateway status.",
  );

  assert.deepEqual(sessionStore.conversations["thread-123"], {
    session_id: "trae-session-1",
    conversation_id: "trae-conversation-1",
    last_task_id: "task-1",
    last_message_id: "message-1",
    turn_count: 1,
    model: "gpt-5.4",
    user_id: "user-1",
    pending_tool_calls: [
      {
        toolcall_id: "tool-1",
        tool_name: "search_codebase",
        arguments: '{"query":"gateway"}',
        agent_run_id: "agent-run-1",
        file_path: "",
      },
    ],
  });
});

test("chat completions streams OpenAI SSE chunks from Trae SSE events", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            userId: "user-1",
            deviceId: "device-1",
            ideVersion: "3.5.42",
            pluginChannel: "stable",
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
            appLanguage: "en-US",
          };
        },
        async createAgentTask() {
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              `data: ${JSON.stringify({
                tool_name: "run_command",
                toolcall_id: "tool-7",
                arguments: { command: "npm test" },
              })}\n\n`,
              `data: ${JSON.stringify({
                content: "Tool result incoming",
                session_id: "trae-session-7",
                task_id: "task-7",
              })}\n\n`,
            ]),
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "trae-agent",
      stream: true,
      user: "user-1",
      metadata: { conversation_id: "thread-stream-1" },
      messages: [{ role: "user", content: "Run the tool." }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const raw = await response.text();
  const chunks = raw
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^data:\s*/, ""));

  assert.equal(chunks[chunks.length - 1], "[DONE]");

  const payloads = chunks
    .slice(0, -1)
    .map((part) => JSON.parse(part));

  assert.deepEqual(payloads[0].choices[0], {
    index: 0,
    delta: {
      tool_calls: [
        {
          index: 0,
          id: "tool-7",
          type: "function",
          function: {
            name: "run_command",
            arguments: '{"command":"npm test"}',
          },
        },
      ],
    },
    finish_reason: null,
  });
  assert.deepEqual(payloads[1].choices[0], {
    index: 0,
    delta: { content: "Tool result incoming" },
    finish_reason: null,
  });
  assert.equal(payloads[2].choices[0].finish_reason, "tool_calls");
});

test("chat completions in template mode render placeholders before forwarding", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-template-"));
  const templatePath = path.join(tempDir, "agent-template.json");
  fs.writeFileSync(
    templatePath,
    JSON.stringify({
      query: "{{prompt}}",
      model: "{{model}}",
      session_id: "{{session_id}}",
      conversation_id: "{{conversation_id}}",
      metadata: {
        trace_id: "{{trace_id}}",
        request_id: "{{request_id}}",
      },
    }),
    "utf8",
  );

  let capturedPayload = null;
  const { server } = createGateway(
    {
      mode: "agent-v3-template",
      agentTemplatePath: templatePath,
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
        async createAgentTask(payload) {
          capturedPayload = payload;
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              `data: ${JSON.stringify({ content: "templated response" })}\n\n`,
            ]),
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Template this." }],
      metadata: { conversation_id: "thread-template-1" },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "templated response");
  assert.equal(capturedPayload.query, "USER:\nTemplate this.");
  assert.equal(capturedPayload.model, "gemini-3.1-pro");
  assert.match(capturedPayload.session_id, /^[a-f0-9]{24}$/);
  assert.match(capturedPayload.conversation_id, /^[a-f0-9]{24}$/);
  assert.notEqual(capturedPayload.metadata.trace_id, "{{trace_id}}");
  assert.notEqual(capturedPayload.metadata.request_id, "{{request_id}}");
});

test("chat completions return not_implemented when template mode is missing a template file", async (t) => {
  const { server } = createGateway(
    {
      mode: "raw-chat-template",
      rawChatTemplatePath: path.join(os.tmpdir(), "missing-template.json"),
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    error: {
      message:
        "Gateway is running, but TRAE_RAW_CHAT_TEMPLATE_PATH is not configured. Capture one real Trae payload for /api/ide/v2/llm_raw_chat, save it as JSON, replace changing fields with placeholders, and set TRAE_RAW_CHAT_TEMPLATE_PATH.",
      type: "not_implemented",
    },
  });
});

test("chat completions return configuration_error for malformed template JSON", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-bad-template-"));
  const templatePath = path.join(tempDir, "agent-template.json");
  fs.writeFileSync(templatePath, '{"query":"{{prompt}}"', "utf8");

  const { server } = createGateway(
    {
      mode: "agent-v3-template",
      agentTemplatePath: templatePath,
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      message: `Template file is not valid JSON: ${templatePath}`,
      type: "configuration_error",
    },
  });
});

test("chat completions map upstream rate limit errors into OpenAI-style errors", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
        async createAgentTask() {
          return {
            ok: false,
            status: 429,
            text: JSON.stringify({ error: { message: "slow down" } }),
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), {
    error: {
      message: "slow down",
      type: "rate_limit_error",
    },
  });
});

test("chat completions map upstream SSE error events into OpenAI-style errors", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
        async createAgentTask() {
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              'event:error\ndata: {"code":4001,"message":"model config is empty for model name: gemini-3.1-pro"}\n\n',
            ]),
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      message: "model config is empty for model name: gemini-3.1-pro",
      type: "invalid_request_error",
    },
  });
});

test("streaming chat completions fail before opening SSE when upstream starts with an error event", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
        async createAgentTask() {
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              'event:error\ndata: {"code":4001,"message":"failed to get summary config"}\n\n',
            ]),
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), {
    error: {
      message:
        "Trae agent-v3 runtime is still incomplete for direct external calls in this build: failed to get summary config. Capture a real /api/agent/v3/create_agent_task payload and use TRAE_PROXY_MODE=agent-v3-template.",
      type: "invalid_request_error",
    },
  });
});

test("tool-result continuation requires a stable conversation key", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
      },
      sessionStore: createMemorySessionStore(),
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_codebase", arguments: '{"query":"gateway"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "found matches",
        },
      ],
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      message:
        "Tool result continuation requires a stable conversation key via metadata, headers, or user.",
      type: "invalid_request_error",
    },
  });
});

test("tool-result continuation forwards commit_toolcall_result payload and clears pending tool calls", async (t) => {
  let capturedPayload = null;
  let createAgentTaskCalled = false;
  const sessionStore = createMemorySessionStore({
    "thread-tool-1": {
      session_id: "session-1",
      conversation_id: "conversation-1",
      last_task_id: "task-1",
      last_message_id: "message-1",
      turn_count: 2,
      model: "gemini-3.1-pro",
      user_id: "user-1",
      pending_tool_calls: [
        {
          toolcall_id: "call-1",
          tool_name: "search_codebase",
          arguments: '{"query":"gateway"}',
          agent_run_id: "agent-run-1",
          file_path: "",
        },
      ],
    },
  });
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: "ignored.json",
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
            defaultConfigName: "gemini-3.1-pro",
          };
        },
        async createAgentTask() {
          createAgentTaskCalled = true;
          throw new Error("should not create a new task for tool continuation");
        },
        async commitToolcallResult(payload) {
          capturedPayload = payload;
          return {
            ok: true,
            status: 200,
            body: Readable.from([
              `data: ${JSON.stringify({
                session_id: "session-1",
                conversation_id: "conversation-1",
                task_id: "task-1",
                message_id: "message-2",
                content: "Tool result applied",
              })}\n\n`,
            ]),
          };
        },
      },
      sessionStore,
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      metadata: { conversation_id: "thread-tool-1" },
      user: "user-1",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "search_codebase",
                arguments: '{"query":"gateway"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "found matches",
        },
      ],
    }),
  });

  assert.equal(createAgentTaskCalled, false);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "Tool result applied");
  assert.deepEqual(capturedPayload, {
    task_id: "task-1",
    conversation_id: "conversation-1",
    session_id: "session-1",
    message_id: "message-1",
    user_id: "user-1",
    toolcall_results: [
      {
        agent_run_id: "agent-run-1",
        toolcall_id: "call-1",
        toolcall_name: "search_codebase",
        toolcall_resp: "found matches",
        toolcall_status: "success",
        toolcall_error_message: "",
        toolcall_params: '{"query":"gateway"}',
        is_truncated: false,
        file_path: "",
      },
    ],
  });
  assert.deepEqual(sessionStore.conversations["thread-tool-1"], {
    session_id: "session-1",
    conversation_id: "conversation-1",
    last_task_id: "task-1",
    last_message_id: "message-2",
    turn_count: 3,
    model: "gemini-3.1-pro",
    user_id: "user-1",
    pending_tool_calls: [],
  });
});

function createMemorySessionStore(initialConversations = {}) {
  return {
    conversations: { ...initialConversations },
    getConversation(key) {
      return this.conversations[key] || null;
    },
    ensureConversation(key, createValue) {
      if (!this.conversations[key]) {
        this.conversations[key] =
          typeof createValue === "function" ? createValue() : createValue;
      }

      return this.conversations[key];
    },
    upsertConversation(key, value) {
      const nextValue = {
        ...(this.conversations[key] || {}),
        ...value,
      };

      this.conversations[key] = nextValue;
      return nextValue;
    },
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
