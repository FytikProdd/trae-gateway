const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createConfig, createGateway, loadDotEnv, mapUpstreamError } = require("../src/app");

test("loadDotEnv loads missing variables without overriding existing ones", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-env-"));
  const envPath = path.join(tempDir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "PORT=9999",
      "TRAE_DEBUG='false'",
      "TRAE_AGENT_TEMPLATE_PATH=\"templates/agent.json\"",
      "EXISTING_VAR=from-file",
    ].join("\n"),
    "utf8",
  );

  const previous = {
    PORT: process.env.PORT,
    TRAE_DEBUG: process.env.TRAE_DEBUG,
    TRAE_AGENT_TEMPLATE_PATH: process.env.TRAE_AGENT_TEMPLATE_PATH,
    EXISTING_VAR: process.env.EXISTING_VAR,
  };

  t.after(() => {
    restoreEnv("PORT", previous.PORT);
    restoreEnv("TRAE_DEBUG", previous.TRAE_DEBUG);
    restoreEnv("TRAE_AGENT_TEMPLATE_PATH", previous.TRAE_AGENT_TEMPLATE_PATH);
    restoreEnv("EXISTING_VAR", previous.EXISTING_VAR);
  });

  delete process.env.PORT;
  delete process.env.TRAE_DEBUG;
  delete process.env.TRAE_AGENT_TEMPLATE_PATH;
  process.env.EXISTING_VAR = "keep-me";

  loadDotEnv(envPath);

  assert.equal(process.env.PORT, "9999");
  assert.equal(process.env.TRAE_DEBUG, "false");
  assert.equal(process.env.TRAE_AGENT_TEMPLATE_PATH, "templates/agent.json");
  assert.equal(process.env.EXISTING_VAR, "keep-me");
});

test("createConfig resolves relative paths and primitive options", () => {
  const config = createConfig({
    TRAE_BIND_HOST: "0.0.0.0",
    PORT: "5000",
    TRAE_DEBUG: "false",
    TRAE_PROXY_MODE: "agent-v3-template",
    TRAE_AGENT_TEMPLATE_PATH: "templates/agent.json",
    TRAE_RAW_CHAT_TEMPLATE_PATH: "templates/raw.json",
    TRAE_STORAGE_PATH: "storage/storage.json",
    TRAE_PRODUCT_PATH: "product/product.json",
    TRAE_LOGS_PATH: "logs",
    TRAE_SESSION_STORE_PATH: "state/sessions.json",
    TRAE_REQUEST_TIMEOUT_MS: "45000",
  }, "C:\\workspace\\repo");

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 5000);
  assert.equal(config.debug, false);
  assert.equal(config.mode, "agent-v3-template");
  assert.equal(config.agentTemplatePath, "C:\\workspace\\repo\\templates\\agent.json");
  assert.equal(config.rawChatTemplatePath, "C:\\workspace\\repo\\templates\\raw.json");
  assert.equal(config.storagePath, "C:\\workspace\\repo\\storage\\storage.json");
  assert.equal(config.productPath, "C:\\workspace\\repo\\product\\product.json");
  assert.equal(config.logsPath, "C:\\workspace\\repo\\logs");
  assert.equal(config.sessionStorePath, "C:\\workspace\\repo\\state\\sessions.json");
  assert.equal(config.requestTimeoutMs, 45000);
});

test("mapUpstreamError classifies common upstream failures", () => {
  assert.deepEqual(
    mapUpstreamError({
      errorCode: "ETIMEDOUT",
      status: 408,
      text: "",
    }),
    {
      status: 504,
      type: "timeout_error",
      message: "Trae upstream timed out before returning a response.",
    },
  );

  assert.deepEqual(
    mapUpstreamError({
      status: 429,
      text: JSON.stringify({ error: { message: "slow down" } }),
    }),
    {
      status: 429,
      type: "rate_limit_error",
      message: "slow down",
    },
  );

  assert.deepEqual(
    mapUpstreamError({
      status: 500,
      text: "backend exploded",
    }),
    {
      status: 502,
      type: "server_error",
      message: "backend exploded",
    },
  );
});

test("createGateway keeps health/debug routes available without local Trae state", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: path.join(os.tmpdir(), "ignored.json"),
    },
    {
      trae: {
        getBaseDomain() {
          throw new Error("missing local profile");
        },
        readAuth() {
          throw new Error("missing local auth");
        },
      },
      sessionStore: {},
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae" }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const [healthResponse, authResponse, modelsResponse] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/debug/auth`),
    fetch(`${baseUrl}/v1/models`),
  ]);

  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    listenHost: "127.0.0.1",
    mode: "agent-v3-auto",
    baseDomain: null,
  });

  assert.equal(authResponse.status, 200);
  assert.deepEqual(await authResponse.json(), {
    ok: true,
    baseDomain: null,
    auth: null,
  });

  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(await modelsResponse.json(), {
    object: "list",
    data: [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae" }],
  });
});

test("createGateway exposes runtime diagnostics when the Trae client supports them", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: path.join(os.tmpdir(), "ignored.json"),
    },
    {
      trae: {
        async getRuntimeDiagnostics() {
          return {
            ok: true,
            assessment: {
              likelyBlocker: "desktop_session_history_bootstrap",
            },
          };
        },
      },
      sessionStore: {},
      modelDiscovery: {
        discover() {
          return [];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const response = await fetch(`${baseUrl}/debug/runtime`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    assessment: {
      likelyBlocker: "desktop_session_history_bootstrap",
    },
  });
});

test("createGateway returns an authentication error before upstream chat calls", async (t) => {
  let upstreamCalled = false;
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: path.join(os.tmpdir(), "ignored.json"),
    },
    {
      trae: {
        getAuthState() {
          return {
            ok: false,
            message: "Trae auth token is missing in the local profile.",
          };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
          };
        },
        async createAgentTask() {
          upstreamCalled = true;
          throw new Error("should not be called");
        },
      },
      sessionStore: {},
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

  assert.equal(upstreamCalled, false);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      message: "Trae auth token is missing in the local profile.",
      type: "authentication_error",
    },
  });
});

test("createGateway returns invalid_request_error for malformed JSON bodies", async (t) => {
  const { server } = createGateway(
    {
      mode: "agent-v3-auto",
      sessionStorePath: path.join(os.tmpdir(), "ignored.json"),
    },
    {
      trae: {
        getAuthState() {
          return { ok: true };
        },
        getRuntimeProfile() {
          return {
            defaultModel: "gemini-3.1-pro",
          };
        },
      },
      sessionStore: {},
      modelDiscovery: {
        discover() {
          return [{ id: "gemini-3.1-pro", object: "model", owned_by: "trae", selected: true }];
        },
      },
    },
  );

  const baseUrl = await listen(server);
  t.after(() => closeServer(server));

  const [chatResponse, debugResponse] = await Promise.all([
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"messages":[',
    }),
    fetch(`${baseUrl}/debug/agent/v3/create_agent_task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":',
    }),
  ]);

  assert.equal(chatResponse.status, 400);
  assert.deepEqual(await chatResponse.json(), {
    error: {
      message: "Request body must be valid JSON.",
      type: "invalid_request_error",
    },
  });

  assert.equal(debugResponse.status, 400);
  assert.deepEqual(await debugResponse.json(), {
    error: {
      message: "Request body must be valid JSON.",
      type: "invalid_request_error",
    },
  });
});

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

function restoreEnv(key, value) {
  if (value == null) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
