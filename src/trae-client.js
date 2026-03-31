const fs = require("node:fs");
const path = require("node:path");

const { createRequestId, createTraceId, loadJsonFile, parseJson } = require("./utils");

class TraeClient {
  constructor(options = {}) {
    this.storagePath =
      options.storagePath ||
      path.join(
        resolveWindowsPath("APPDATA", "AppData", "Roaming"),
        "Trae",
        "User",
        "globalStorage",
        "storage.json",
      );
    this.productPath =
      options.productPath ||
      path.join(
        resolveWindowsPath("LOCALAPPDATA", "AppData", "Local"),
        "Programs",
        "Trae",
        "resources",
        "app",
        "product.json",
      );
    this.localEnvPath =
      options.localEnvPath ||
      path.join(
        resolveWindowsPath("APPDATA", "AppData", "Roaming"),
        "Trae",
        "ModularData",
        "ckg_server",
        "local_env.json",
      );
    this.logsPath =
      options.logsPath ||
      path.join(
        resolveWindowsPath("APPDATA", "AppData", "Roaming"),
        "Trae",
        "logs",
      );
    this.debug = options.debug === true;
    this.requestTimeoutMs = Number(options.requestTimeoutMs || 120000);
  }

  readAuth() {
    const storage = loadJsonFile(fs, this.storagePath);
    const raw = storage["iCubeAuthInfo://icube.cloudide"];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  readProduct() {
    return loadJsonFile(fs, this.productPath);
  }

  readLocalEnv() {
    if (!fs.existsSync(this.localEnvPath)) {
      return {};
    }

    return loadJsonFile(fs, this.localEnvPath);
  }

  getBaseDomain(service = "agent") {
    return this.getBaseDomains(service)[0];
  }

  getBaseDomains(service = "agent") {
    const auth = this.readAuth();
    const product = this.readProduct();
    const region = auth?.userRegion?._aiRegion || auth?.userRegion?.region || "SG";
    const candidates = [];

    if (service === "ide") {
      candidates.push(product?.bootConfig?.iCubeAgent?.[region]);
      candidates.push(product?.bootConfig?.iCubeAgent?.normal);
      candidates.push(product?.bootConfig?.agent?.trae?.[region]);
      candidates.push(product?.bootConfig?.agent?.trae?.normal);
    }

    if (service === "agent") {
      candidates.push(product?.bootConfig?.agent?.trae?.[region]);
      candidates.push(product?.bootConfig?.agent?.trae?.normal);
    }

    if (service === "raw-chat") {
      candidates.push(product?.bootConfig?.cue?.trae?.[region]);
      candidates.push(product?.bootConfig?.cue?.trae?.normal);
      candidates.push(product?.bootConfig?.agent?.trae?.[region]);
      candidates.push(product?.bootConfig?.agent?.trae?.normal);
    }

    candidates.push(auth?.host);
    return candidates.filter(Boolean);
  }

  getRuntimeProfile(options = {}) {
    const auth = this.readAuth();
    const product = this.readProduct();
    const storage = loadJsonFile(fs, this.storagePath);
    const localEnv = this.readLocalEnv();
    const defaultModel = typeof options.defaultModel === "string" && options.defaultModel.trim()
      ? options.defaultModel.trim()
      : "gemini-3.1-pro";

    return {
      userId: auth?.userId || auth?.account?.id || "",
      deviceId: String(localEnv?.device_id || "7601457059360212498"),
      machineId: storage?.["telemetry.machineId"] || "841ab318d31a4bf20206cd8084f3fcc82d423d93accf291abd14934c6ed6244f",
      ideVersion: product?.appVersion || "3.5.42",
      ideVersionCode: "20260324",
      appVersion: "default",
      appVersionCode: "20260324",
      ideVersionType: product?.quality || "stable",
      pluginChannel: product?.quality || "stable",
      appLanguage: "en",
      agentType: "builder_v3",
      defaultModel,
      defaultConfigName: defaultModel,
    };
  }

  getAuthState() {
    const auth = this.readAuth();
    if (!auth?.token) {
      return {
        ok: false,
        message: "Trae auth token is missing in the local profile.",
      };
    }

    if (auth.expiredAt && new Date(auth.expiredAt).getTime() <= Date.now()) {
      return {
        ok: false,
        message:
          "Trae auth token is expired in the local profile. Open Trae and refresh the session before using the gateway.",
      };
    }

    return { ok: true };
  }

  createHeaders(extra = {}) {
    const auth = this.readAuth();
    const profile = this.getRuntimeProfile({});
    const traceId = extra.traceId || createTraceId();
    const requestId = extra.requestId || createRequestId();

    return {
      Authorization: `Cloud-IDE-JWT ${auth.token}`,
      "x-ide-token": auth.token,
      "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      "x-app-version": profile.appVersion,
      "x-app-version-code": profile.appVersionCode,
      "x-ide-version-code": profile.ideVersionCode,
      "x-device-id": profile.deviceId,
      "x-machine-id": profile.machineId,
      "x-os-version": "Windows 11 Pro",
      "x-device-type": "windows",
      "x-device-brand": "___________________",
      "x-device-cpu": "Unknown",
      "x-ide-version": profile.ideVersion,
      "x-ide-version-type": profile.ideVersionType,
      "request-traffic-type": "prod",
      "x-custom-trace-id": traceId,
      "x-request-id": requestId,
      "x-trae-request-id": requestId,
      "content-type": "application/json",
    };
  }

  async requestJson(endpointPath, body, options = {}) {
    return this.requestWithFallback("json", endpointPath, body, options);
  }

  async requestSse(endpointPath, body, options = {}) {
    return this.requestWithFallback("sse", endpointPath, body, options);
  }

  async requestWithFallback(kind, endpointPath, body, options = {}) {
    const headers = this.createHeaders(options);
    const bases = endpointPath.startsWith("http")
      ? [""]
      : this.getBaseDomains(options.service || "agent");
    if (bases.length === 0) {
      return {
        ok: false,
        status: 502,
        url: endpointPath,
        headers: {},
        text: "No Trae upstream base domain could be resolved from the local profile.",
        requestHeaders: headers,
        errorCode: "ENOUPSTREAM",
      };
    }

    let lastResult = null;

    for (const base of bases) {
      const url = endpointPath.startsWith("http")
        ? endpointPath
        : `${String(base).replace(/\/+$/, "")}${endpointPath}`;
      const result = await this.performFetch(kind, url, headers, body, options);
      lastResult = result;

      if (result.ok || !isRetryableUpstreamMiss(result.status)) {
        return result;
      }
    }

    return lastResult;
  }

  async performFetch(kind, url, headers, body, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: options.method || "POST",
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (kind === "sse") {
        return {
          ok: response.ok,
          status: response.status,
          url,
          headers: Object.fromEntries(response.headers.entries()),
          body: response.body,
          requestHeaders: headers,
        };
      }

      const rawText = await response.text();
      const parsed = parseJson(rawText, null);

      return {
        ok: response.ok,
        status: response.status,
        url,
        headers: Object.fromEntries(response.headers.entries()),
        text: rawText,
        data: parsed,
        requestHeaders: headers,
      };
    } catch (error) {
      const timedOut =
        error?.name === "AbortError" || error === "timeout" || String(error).includes("timeout");

      return {
        ok: false,
        status: timedOut ? 408 : 502,
        url,
        headers: {},
        text: error instanceof Error ? error.message : String(error),
        requestHeaders: headers,
        errorCode: timedOut ? "ETIMEDOUT" : "EUPSTREAM",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getDetailParam(functionName = "chat_v3", options = {}) {
    return this.requestJson(
      "/api/ide/v1/get_detail_param",
      buildDetailParamRequest(functionName, options),
      { service: options.service || "agent" },
    );
  }

  async resolveModelConfig(functionName = "chat_v3", options = {}) {
    const result = await this.getDetailParam(functionName, options);
    const configInfo = selectConfigInfo(result.data, options);
    const modelDetail = selectModelDetail(configInfo, options);

    return {
      ...result,
      configInfo,
      modelDetail,
      resolvedModelName: modelDetail?.model_name || null,
      resolvedConfigName: configInfo?.config_name || null,
    };
  }

  async createAgentTask(payload) {
    return this.requestSse("/api/agent/v3/create_agent_task", payload, { service: "agent" });
  }

  async commitToolcallResult(payload) {
    return this.requestSse("/api/agent/v3/commit_toolcall_result", payload, {
      service: "agent",
    });
  }

  async llmRawChat(payload) {
    return this.requestSse("/api/ide/v2/llm_raw_chat", payload, { service: "raw-chat" });
  }

  getRuntimeDiagnostics(options = {}) {
    const maxFiles = Number(options.maxFiles || 8);
    const recentLogFiles = listRecentFiles(this.logsPath, /ai-agent_.*_stdout\.log$/i, maxFiles);
    if (recentLogFiles.length === 0) {
      return {
        ok: false,
        logsPath: this.logsPath,
        scannedFiles: [],
        message: "No recent Trae ai-agent stdout logs were found.",
        summaryConfig: null,
        detailParamRequests: {},
        endpointStats: {
          createAgentTask: null,
          commitToolcallResult: null,
        },
        assessment: {
          likelyBlocker: "missing_runtime_logs",
          findings: [
            "Trae ai-agent logs are unavailable, so desktop runtime bootstrap hints could not be reconstructed.",
          ],
          recommendation:
            "Open Trae, send one real prompt, and call GET /debug/runtime again to capture fresh local runtime evidence.",
        },
      };
    }

    const entries = loadLogEntriesNewestFirst(recentLogFiles);
    const summaryConfig = findLatestSummaryConfig(entries);
    const detailParamRequests = collectLatestDetailParamRequests(entries, [
      "chat_v3",
      "builder_v3",
      "builder",
      "solo_builder",
    ]);
    const endpointStats = {
      createAgentTask: collectEndpointDiagnostics(entries, "/api/agent/v3/create_agent_task"),
      commitToolcallResult: collectEndpointDiagnostics(
        entries,
        "/api/agent/v3/commit_toolcall_result",
      ),
    };

    return {
      ok: true,
      logsPath: this.logsPath,
      scannedFiles: recentLogFiles.map((file) => ({
        path: file.path,
        modifiedAt: new Date(file.mtimeMs).toISOString(),
        size: file.size,
      })),
      summaryConfig,
      detailParamRequests,
      endpointStats,
      assessment: buildRuntimeAssessment({
        summaryConfig,
        detailParamRequests,
        endpointStats,
      }),
    };
  }
}

function isRetryableUpstreamMiss(status) {
  return status === 404 || status === 405;
}

function buildDetailParamRequest(functionName, options = {}) {
  const configName = normalizeString(options.configName);
  const currentConfigInfo =
    options.currentConfigInfo !== undefined
      ? options.currentConfigInfo
      : options.useCurrentConfig === true && configName
        ? {
            config_name: configName,
            is_custom_model: false,
          }
        : null;

  return {
    function: functionName,
    config_names: Array.isArray(options.configNames) ? options.configNames : null,
    need_prompt: options.needPrompt !== false,
    current_config_info: currentConfigInfo,
    poly_prompt: options.polyPrompt !== false,
    mode_type: normalizeNullableString(options.modeType),
    agent_type: normalizeNullableString(options.agentType),
    ab_force_vids: options.abForceVids ?? null,
    ab_autotest_advanced_mode: options.abAutotestAdvancedMode ?? null,
  };
}

function selectConfigInfo(detailParamData, options = {}) {
  const configInfoList = Array.isArray(detailParamData?.config_info_list)
    ? detailParamData.config_info_list
    : [];
  if (configInfoList.length === 0) {
    return null;
  }

  const configName = normalizeString(options.configName);
  if (configName) {
    const byConfigName = configInfoList.find((entry) => normalizeString(entry?.config_name) === configName);
    if (byConfigName) {
      return byConfigName;
    }
  }

  const requestedModel = normalizeString(options.model || options.modelName);
  if (requestedModel) {
    const byModelName = configInfoList.find((entry) => entryHasModel(entry, requestedModel));
    if (byModelName) {
      return byModelName;
    }
  }

  return configInfoList[0];
}

function selectModelDetail(configInfo, options = {}) {
  const details = Array.isArray(configInfo?.model_detail_list) ? configInfo.model_detail_list : [];
  if (details.length === 0) {
    return null;
  }

  const requestedModelName = normalizeString(options.modelName || options.model);
  if (requestedModelName) {
    const byModelName = details.find((detail) => normalizeString(detail?.model_name) === requestedModelName);
    if (byModelName) {
      return byModelName;
    }
  }

  return details[0];
}

function entryHasModel(entry, requestedModel) {
  if (normalizeString(entry?.config_name) === requestedModel) {
    return true;
  }

  const details = Array.isArray(entry?.model_detail_list) ? entry.model_detail_list : [];
  return details.some((detail) => normalizeString(detail?.model_name) === requestedModel);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNullableString(value) {
  return value == null ? null : normalizeString(value);
}

function listRecentFiles(rootPath, pattern, maxFiles) {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return [];
  }

  const files = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    let entries = [];

    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!pattern.test(entry.name)) {
        continue;
      }

      try {
        const stat = fs.statSync(fullPath);
        files.push({
          path: fullPath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // Ignore files that disappear or cannot be read.
      }
    }
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, maxFiles));
}

function loadLogEntriesNewestFirst(fileInfos) {
  const entries = [];

  for (const fileInfo of fileInfos) {
    let source = "";

    try {
      source = fs.readFileSync(fileInfo.path, "utf8");
    } catch {
      continue;
    }

    const lines = source.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || !line.trim()) {
        continue;
      }

      entries.push({
        file: fileInfo.path,
        lineNumber: index + 1,
        timestamp: extractLogTimestamp(line),
        line,
      });
    }
  }

  return entries;
}

function extractLogTimestamp(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?[+-]\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function findLatestSummaryConfig(entries) {
  for (const entry of entries) {
    if (!entry.line.includes("agentic_summary_config: Some(")) {
      continue;
    }

    return {
      file: entry.file,
      lineNumber: entry.lineNumber,
      observedAt: entry.timestamp,
      summaryMessageTokenLimit: parseOptionalNumber(entry.line, "summary_message_token_limit"),
      keptHistoryTokenLimit: parseOptionalNumber(entry.line, "kept_history_token_limit"),
      keptHistoryMessageLimit: parseOptionalNumber(entry.line, "kept_history_message_limit"),
      minimumCurrentTurnTokenUsage: parseOptionalNumber(
        entry.line,
        "minimum_current_turn_token_usage",
      ),
      multimodalSummaryLookBackCount: parseOptionalNumber(
        entry.line,
        "multimodal_summary_look_back_count",
      ),
    };
  }

  return null;
}

function collectLatestDetailParamRequests(entries, functionNames) {
  const output = {};

  for (const functionName of functionNames) {
    output[functionName] = findLatestDetailParamRequest(entries, functionName);
  }

  return output;
}

function findLatestDetailParamRequest(entries, functionName) {
  const marker = `function: "${functionName}"`;

  for (const entry of entries) {
    if (!entry.line.includes("DetailParamRequest")) {
      continue;
    }

    if (!entry.line.includes(marker)) {
      continue;
    }

    return {
      file: entry.file,
      lineNumber: entry.lineNumber,
      observedAt: entry.timestamp,
      functionName,
      needPrompt: parseOptionalBoolean(entry.line, "need_prompt"),
      polyPrompt: parseOptionalBoolean(entry.line, "poly_prompt"),
      modeType: parseOptionalValue(entry.line, "mode_type"),
      agentType: parseOptionalValue(entry.line, "agent_type"),
      currentConfigInfo:
        entry.line.includes("current_config_info: None")
          ? null
          : entry.line.includes("current_config_info:")
            ? "present"
            : null,
    };
  }

  return null;
}

function collectEndpointDiagnostics(entries, endpointPath) {
  const recentRequests = [];
  let latestStatus = null;

  for (const entry of entries) {
    if (recentRequests.length < 5) {
      const requestMatch = parseEndpointRequest(entry, endpointPath);
      if (requestMatch) {
        recentRequests.push(requestMatch);
      }
    }

    if (!latestStatus) {
      latestStatus = parseEndpointStatus(entry, endpointPath);
    }

    if (recentRequests.length >= 5 && latestStatus) {
      break;
    }
  }

  if (recentRequests.length === 0 && !latestStatus) {
    return null;
  }

  const bodyLengths = recentRequests
    .map((entry) => entry.bodyLength)
    .filter((value) => Number.isFinite(value));

  return {
    endpointPath,
    latestRequest: recentRequests[0] || null,
    latestStatus,
    recentRequests,
    bodyLengthRange:
      bodyLengths.length === 0
        ? null
        : {
            min: Math.min(...bodyLengths),
            max: Math.max(...bodyLengths),
          },
  };
}

function parseEndpointRequest(entry, endpointPath) {
  if (!entry.line.includes(endpointPath)) {
    return null;
  }

  if (!entry.line.includes("[aha_net] send: calling Fetch")) {
    return null;
  }

  const requestId = extractInlineValue(entry.line, /id=([^,\s]+)/);
  const url = extractInlineValue(entry.line, /url=(https?:\/\/[^,\s]+)/);
  const method = extractInlineValue(entry.line, /method=([A-Z]+)/);
  const headersCount = parseInteger(extractInlineValue(entry.line, /headers_count=(\d+)/));
  const bodyLength = parseInteger(extractInlineValue(entry.line, /body_len=(\d+)/));

  return {
    file: entry.file,
    lineNumber: entry.lineNumber,
    observedAt: entry.timestamp,
    requestId,
    method,
    url,
    headersCount,
    bodyLength,
    traceId: extractInlineValue(entry.line, /trace_id="([^"]+)"/),
    sessionId: extractInlineValue(entry.line, /session_id=([a-zA-Z0-9]+)/),
    taskId: extractInlineValue(entry.line, /task_id=([a-zA-Z0-9]+)/),
    messageId: extractInlineValue(entry.line, /message_id=([a-zA-Z0-9]+)/),
  };
}

function parseEndpointStatus(entry, endpointPath) {
  if (!entry.line.includes(endpointPath)) {
    return null;
  }

  if (!entry.line.includes("[AhaNetHTTPClient/Stream]")) {
    return null;
  }

  return {
    file: entry.file,
    lineNumber: entry.lineNumber,
    observedAt: entry.timestamp,
    url: extractInlineValue(entry.line, /(https?:\/\/[^,\s]+)/),
    status: parseInteger(extractInlineValue(entry.line, /Status:\s+(\d+)/)),
    logId: extractInlineValue(entry.line, /LogID:\s+([A-Za-z0-9]+)/),
    traceId: extractInlineValue(entry.line, /trace_id="([^"]+)"/),
    sessionId: extractInlineValue(entry.line, /session_id=([a-zA-Z0-9]+)/),
    taskId: extractInlineValue(entry.line, /task_id=([a-zA-Z0-9]+)/),
    messageId: extractInlineValue(entry.line, /message_id=([a-zA-Z0-9]+)/),
  };
}

function buildRuntimeAssessment({ summaryConfig, detailParamRequests, endpointStats }) {
  const findings = [];

  if (summaryConfig) {
    findings.push(
      "Local Trae ai-agent logs expose a desktop-only agentic summary config, so summary bootstrap is happening inside the app runtime.",
    );
  }

  const chatV3 = detailParamRequests?.chat_v3;
  if (chatV3?.needPrompt === true && chatV3.modeType == null && chatV3.agentType == null) {
    findings.push(
      "Recent chat_v3 get_detail_param requests use need_prompt=true without forcing mode_type or agent_type, which matches the live-compatible external bootstrap.",
    );
  }

  const createAgentTask = endpointStats?.createAgentTask;
  if (createAgentTask?.bodyLengthRange) {
    findings.push(
      `Historical desktop create_agent_task payloads are much larger (${createAgentTask.bodyLengthRange.min}-${createAgentTask.bodyLengthRange.max} bytes), which implies extra prompt, history, or session state beyond the gateway auto payload.`,
    );
  }

  const commitToolcallResult = endpointStats?.commitToolcallResult;
  if (commitToolcallResult?.bodyLengthRange) {
    findings.push(
      `Historical commit_toolcall_result payload sizes also vary widely (${commitToolcallResult.bodyLengthRange.min}-${commitToolcallResult.bodyLengthRange.max} bytes), so the tool loop clearly carries richer runtime context than a single follow-up tool message.`,
    );
  }

  let likelyBlocker = "insufficient_runtime_evidence";
  let recommendation =
    "Capture a fresh desktop prompt in Trae and re-check GET /debug/runtime for more runtime evidence.";

  if (summaryConfig && createAgentTask?.latestRequest) {
    likelyBlocker = "desktop_session_history_bootstrap";
    recommendation =
      "Use TRAE_PROXY_MODE=agent-v3-template with a captured desktop create_agent_task payload until the missing session/history bootstrap path is reconstructed.";
  } else if (summaryConfig) {
    likelyBlocker = "missing_desktop_task_bootstrap";
    recommendation =
      "The gateway can already resolve model config, but it still needs more of the desktop bootstrap path before create_agent_task.";
  }

  return {
    likelyBlocker,
    findings,
    recommendation,
  };
}

function parseOptionalNumber(line, fieldName) {
  return parseInteger(extractRustOptionValue(line, fieldName));
}

function parseOptionalBoolean(line, fieldName) {
  const value = extractRustOptionValue(line, fieldName);
  if (value == null) {
    return null;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return null;
}

function parseOptionalValue(line, fieldName) {
  const value = extractRustOptionValue(line, fieldName);
  if (value == null) {
    return null;
  }

  return stripWrappingQuotes(value);
}

function extractRustOptionValue(line, fieldName) {
  const pattern = new RegExp(`${escapeRegex(fieldName)}:\\s+(Some\\(([^)]+)\\)|None)`);
  const match = line.match(pattern);
  if (!match) {
    return null;
  }

  if (match[1] === "None") {
    return null;
  }

  return match[2] || null;
}

function extractInlineValue(line, pattern) {
  const match = line.match(pattern);
  return match ? match[1] : null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripWrappingQuotes(value) {
  const text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }

  return text;
}

function parseInteger(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveWindowsPath(envName, ...fallbackSegments) {
  if (process.env[envName]) {
    return process.env[envName];
  }

  if (process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, ...fallbackSegments);
  }

  return path.resolve(...fallbackSegments);
}

module.exports = { TraeClient };
