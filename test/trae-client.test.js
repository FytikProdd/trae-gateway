const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { TraeClient } = require("../src/trae-client");

test("TraeClient reads auth, product, local env, and derives runtime profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-client-"));
  const storagePath = path.join(tempDir, "storage.json");
  const productPath = path.join(tempDir, "product.json");
  const localEnvPath = path.join(tempDir, "local_env.json");

  fs.writeFileSync(
    storagePath,
    JSON.stringify({
      "iCubeAuthInfo://icube.cloudide": JSON.stringify({
        token: "token-123",
        userId: "user-123",
        host: "https://auth-host.example",
        userRegion: { _aiRegion: "US" },
      }),
      "telemetry.machineId": "machine-123",
    }),
    "utf8",
  );
  fs.writeFileSync(
    productPath,
    JSON.stringify({
      appVersion: "9.9.9",
      quality: "insider",
      bootConfig: {
        agent: {
          trae: {
            US: "https://agent-us.example",
            normal: "https://agent-normal.example",
          },
        },
        iCubeAgent: {
          US: "https://ide-us.example",
          normal: "https://ide-normal.example",
        },
        cue: {
          trae: {
            US: "https://raw-us.example",
            normal: "https://raw-normal.example",
          },
        },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(localEnvPath, JSON.stringify({ device_id: 42 }), "utf8");

  const client = new TraeClient({ storagePath, productPath, localEnvPath });

  assert.deepEqual(client.readAuth(), {
    token: "token-123",
    userId: "user-123",
    host: "https://auth-host.example",
    userRegion: { _aiRegion: "US" },
  });
  assert.equal(client.readProduct().appVersion, "9.9.9");
  assert.deepEqual(client.readLocalEnv(), { device_id: 42 });

  assert.deepEqual(client.getBaseDomains("agent"), [
    "https://agent-us.example",
    "https://agent-normal.example",
    "https://auth-host.example",
  ]);
  assert.deepEqual(client.getBaseDomains("ide"), [
    "https://ide-us.example",
    "https://ide-normal.example",
    "https://agent-us.example",
    "https://agent-normal.example",
    "https://auth-host.example",
  ]);
  assert.deepEqual(client.getBaseDomains("raw-chat"), [
    "https://raw-us.example",
    "https://raw-normal.example",
    "https://agent-us.example",
    "https://agent-normal.example",
    "https://auth-host.example",
  ]);

  assert.deepEqual(client.getRuntimeProfile({ defaultModel: "gpt-5.4" }), {
    userId: "user-123",
    deviceId: "42",
    machineId: "machine-123",
    ideVersion: "9.9.9",
    ideVersionCode: "20260324",
    appVersion: "default",
    appVersionCode: "20260324",
    ideVersionType: "insider",
    pluginChannel: "insider",
    appLanguage: "en",
    agentType: "builder_v3",
    defaultModel: "gpt-5.4",
    defaultConfigName: "gpt-5.4",
  });
});

test("TraeClient getAuthState reports missing and expired tokens", () => {
  const missingTokenClient = {
    readAuth() {
      return {};
    },
  };
  const expiredTokenClient = {
    readAuth() {
      return {
        token: "token-123",
        expiredAt: "2000-01-01T00:00:00.000Z",
      };
    },
  };
  const validTokenClient = {
    readAuth() {
      return {
        token: "token-123",
        expiredAt: "2999-01-01T00:00:00.000Z",
      };
    },
  };

  assert.deepEqual(TraeClient.prototype.getAuthState.call(missingTokenClient), {
    ok: false,
    message: "Trae auth token is missing in the local profile.",
  });
  assert.deepEqual(TraeClient.prototype.getAuthState.call(expiredTokenClient), {
    ok: false,
    message:
      "Trae auth token is expired in the local profile. Open Trae and refresh the session before using the gateway.",
  });
  assert.deepEqual(TraeClient.prototype.getAuthState.call(validTokenClient), {
    ok: true,
  });
});

test("TraeClient requestWithFallback retries retryable misses and returns the first success", async (t) => {
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
  });

  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return createJsonResponse(404, { message: "missing on first host" });
    }

    return createJsonResponse(200, { ok: true, host: "second" });
  };

  const client = {
    requestTimeoutMs: 1000,
    createHeaders() {
      return { Authorization: "Cloud-IDE-JWT token-123" };
    },
    getBaseDomains() {
      return ["https://first.example/", "https://second.example"];
    },
    performFetch: TraeClient.prototype.performFetch,
  };

  const result = await TraeClient.prototype.requestWithFallback.call(
    client,
    "json",
    "/api/test",
    { hello: "world" },
    { service: "agent" },
  );

  assert.deepEqual(calls, [
    "https://first.example/api/test",
    "https://second.example/api/test",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { ok: true, host: "second" });
});

test("TraeClient requestWithFallback returns a clear error when no upstream base domain exists", async () => {
  const client = {
    createHeaders() {
      return { Authorization: "Cloud-IDE-JWT token-123" };
    },
    getBaseDomains() {
      return [];
    },
  };

  const result = await TraeClient.prototype.requestWithFallback.call(
    client,
    "json",
    "/api/test",
    { hello: "world" },
    { service: "agent" },
  );

  assert.deepEqual(result, {
    ok: false,
    status: 502,
    url: "/api/test",
    headers: {},
    text: "No Trae upstream base domain could be resolved from the local profile.",
    requestHeaders: { Authorization: "Cloud-IDE-JWT token-123" },
    errorCode: "ENOUPSTREAM",
  });
});

test("TraeClient requestWithFallback does not retry non-retryable upstream errors", async (t) => {
  const previousFetch = global.fetch;
  t.after(() => {
    global.fetch = previousFetch;
  });

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return createJsonResponse(429, { error: { message: "rate limited" } });
  };

  const client = {
    requestTimeoutMs: 1000,
    createHeaders() {
      return { Authorization: "Cloud-IDE-JWT token-123" };
    },
    getBaseDomains() {
      return ["https://first.example", "https://second.example"];
    },
    performFetch: TraeClient.prototype.performFetch,
  };

  const result = await TraeClient.prototype.requestWithFallback.call(
    client,
    "json",
    "/api/test",
    null,
    { service: "agent" },
  );

  assert.equal(calls, 1);
  assert.equal(result.status, 429);
  assert.deepEqual(result.data, { error: { message: "rate limited" } });
});

test("TraeClient getDetailParam uses the live-compatible request shape by default", async () => {
  let captured = null;
  const client = {
    async requestJson(path, body, options) {
      captured = { path, body, options };
      return { ok: true, status: 200, data: {} };
    },
  };

  await TraeClient.prototype.getDetailParam.call(client, "chat_v3", {
    configName: "gemini-3.1-pro",
  });

  assert.deepEqual(captured, {
    path: "/api/ide/v1/get_detail_param",
    body: {
      function: "chat_v3",
      config_names: null,
      need_prompt: true,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
      ab_force_vids: null,
      ab_autotest_advanced_mode: null,
    },
    options: { service: "agent" },
  });
});

test("TraeClient resolveModelConfig selects the matching config and runtime model name", async () => {
  const client = {
    async getDetailParam() {
      return {
        ok: true,
        status: 200,
        data: {
          config_info_list: [
            {
              config_name: "gpt-5.4",
              model_detail_list: [{ model_name: "gpt-5.4__dollar__dev" }],
            },
            {
              config_name: "gemini-3.1-pro",
              model_detail_list: [{ model_name: "gemini-3.1-pro__dollar__dev" }],
            },
          ],
        },
      };
    },
  };

  const result = await TraeClient.prototype.resolveModelConfig.call(client, "chat_v3", {
    model: "gemini-3.1-pro",
  });

  assert.equal(result.resolvedConfigName, "gemini-3.1-pro");
  assert.equal(result.resolvedModelName, "gemini-3.1-pro__dollar__dev");
  assert.deepEqual(result.modelDetail, {
    model_name: "gemini-3.1-pro__dollar__dev",
  });
});

test("TraeClient getRuntimeDiagnostics extracts summary config, detail-param hints, and endpoint stats", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-runtime-"));
  const logsPath = path.join(tempDir, "logs");
  const sessionDir = path.join(logsPath, "20260331T023637", "Modular");
  fs.mkdirSync(sessionDir, { recursive: true });

  const logPath = path.join(sessionDir, "ai-agent_0_1774913797419_stdout.log");
  fs.writeFileSync(
    logPath,
    [
      "2026-03-31T03:07:09.128080+03:00  INFO get_model_detail_param: req=DetailParamRequest { function: \"chat_v3\", config_names: None, need_prompt: Some(true), current_config_info: None, poly_prompt: Some(true), mode_type: None, agent_type: None, ab_force_vids: None, ab_autotest_advanced_mode: None }",
      "2026-03-31T03:13:01.346329+03:00  INFO dynamic_config: Dynamic config updated, config: DynamicConfigData { agentic_summary_config: Some(DymanicAgenticSummaryConfig { summary_message_token_limit: Some(2000), kept_history_token_limit: Some(8000), kept_history_message_limit: Some(4), minimum_current_turn_token_usage: Some(15000), multimodal_summary_look_back_count: Some(3) }) }",
      "2026-03-31T03:13:20.973639+03:00  INFO send_streaming: byted_aha_ffi::aha_net::http: [aha_net] send: calling Fetch id=req_commit, method=POST, url=https://coresg-normal.trae.ai/api/agent/v3/commit_toolcall_result, headers_count=26, body_len=684 trace_id=\"trace-commit\" session_id=69ca8b9a344666a79c4ffec3 task_id=69ca8bc4344666a79c4ffec8 message_id=69ca8bc4344666a79c4ffec7",
      "2026-03-31T03:13:21.379167+03:00  INFO transport: [AhaNetHTTPClient/Stream] https://coresg-normal.trae.ai/api/agent/v3/commit_toolcall_result, Status: 200, LogID: LOGCOMMIT trace_id=\"trace-commit\" session_id=69ca8b9a344666a79c4ffec3 task_id=69ca8bc4344666a79c4ffec8 message_id=69ca8bc4344666a79c4ffec7",
      "2026-03-31T03:13:22.988725+03:00  INFO send_streaming: byted_aha_ffi::aha_net::http: [aha_net] send: calling Fetch id=req_create, method=POST, url=https://coresg-normal.trae.ai/api/agent/v3/create_agent_task, headers_count=26, body_len=10156 trace_id=\"trace-create\" session_id=69ca8b9a344666a79c4ffec3 task_id=69ca8bc4344666a79c4ffec8 message_id=69ca8bc4344666a79c4ffec7",
      "2026-03-31T03:13:23.422439+03:00  INFO transport: [AhaNetHTTPClient/Stream] https://coresg-normal.trae.ai/api/agent/v3/create_agent_task, Status: 200, LogID: LOGCREATE trace_id=\"trace-create\" session_id=69ca8b9a344666a79c4ffec3 task_id=69ca8bc4344666a79c4ffec8 message_id=69ca8bc4344666a79c4ffec7",
    ].join("\n"),
    "utf8",
  );

  const client = new TraeClient({ logsPath });
  const diagnostics = client.getRuntimeDiagnostics();

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.scannedFiles.length, 1);
  assert.deepEqual(diagnostics.summaryConfig, {
    file: logPath,
    lineNumber: 2,
    observedAt: "2026-03-31T03:13:01.346329+03:00",
    summaryMessageTokenLimit: 2000,
    keptHistoryTokenLimit: 8000,
    keptHistoryMessageLimit: 4,
    minimumCurrentTurnTokenUsage: 15000,
    multimodalSummaryLookBackCount: 3,
  });
  assert.deepEqual(diagnostics.detailParamRequests.chat_v3, {
    file: logPath,
    lineNumber: 1,
    observedAt: "2026-03-31T03:07:09.128080+03:00",
    functionName: "chat_v3",
    needPrompt: true,
    polyPrompt: true,
    modeType: null,
    agentType: null,
    currentConfigInfo: null,
  });
  assert.equal(diagnostics.endpointStats.createAgentTask.latestRequest.bodyLength, 10156);
  assert.equal(diagnostics.endpointStats.createAgentTask.latestStatus.status, 200);
  assert.equal(diagnostics.endpointStats.commitToolcallResult.latestRequest.bodyLength, 684);
  assert.equal(
    diagnostics.assessment.likelyBlocker,
    "desktop_session_history_bootstrap",
  );
});

function createJsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    async text() {
      return text;
    },
  };
}
