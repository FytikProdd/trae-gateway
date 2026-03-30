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
    this.debug = options.debug === true;
  }

  readAuth() {
    const storage = loadJsonFile(fs, this.storagePath);
    const raw = storage["iCubeAuthInfo://icube.cloudide"];
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  readProduct() {
    return loadJsonFile(fs, this.productPath);
  }

  getBaseDomain() {
    const auth = this.readAuth();
    if (auth?.host) {
      return auth.host;
    }

    const product = this.readProduct();
    return product?.agent?.domain || "https://coresg-normal.trae.ai";
  }

  createHeaders(extra = {}) {
    const auth = this.readAuth();
    const traceId = extra.traceId || createTraceId();
    const requestId = extra.requestId || createRequestId();

    return {
      Authorization: `Cloud-IDE-JWT ${auth.token}`,
      "x-ide-token": auth.token,
      "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      "x-app-version": "default",
      "x-app-version-code": "20260324",
      "x-ide-version-code": "20260324",
      "x-device-id": "7601457059360212498",
      "x-machine-id": "841ab318d31a4bf20206cd8084f3fcc82d423d93accf291abd14934c6ed6244f",
      "x-os-version": "Windows 11 Pro",
      "x-device-type": "windows",
      "x-device-brand": "___________________",
      "x-device-cpu": "Unknown",
      "x-ide-version": "3.5.42",
      "x-ide-version-type": "stable",
      "request-traffic-type": "prod",
      "x-custom-trace-id": traceId,
      "x-request-id": requestId,
      "x-trae-request-id": requestId,
      "content-type": "application/json",
    };
  }

  async requestJson(endpointPath, body, options = {}) {
    const base = this.getBaseDomain().replace(/\/+$/, "");
    const url = endpointPath.startsWith("http") ? endpointPath : `${base}${endpointPath}`;
    const headers = this.createHeaders(options);

    const response = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });

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
  }

  async requestSse(endpointPath, body, options = {}) {
    const base = this.getBaseDomain().replace(/\/+$/, "");
    const url = endpointPath.startsWith("http") ? endpointPath : `${base}${endpointPath}`;
    const headers = this.createHeaders(options);

    const response = await fetch(url, {
      method: options.method || "POST",
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });

    return {
      ok: response.ok,
      status: response.status,
      url,
      headers: Object.fromEntries(response.headers.entries()),
      body: response.body,
      requestHeaders: headers,
    };
  }

  async getDetailParam(functionName = "chat_v3") {
    return this.requestJson("/api/ide/v1/get_detail_param", {
      function: functionName,
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: "Manual",
      agent_type: null,
      ab_force_vids: null,
      ab_autotest_advanced_mode: null,
    });
  }

  async createAgentTask(payload) {
    return this.requestSse("/api/agent/v3/create_agent_task", payload);
  }

  async commitToolcallResult(payload) {
    return this.requestSse("/api/agent/v3/commit_toolcall_result", payload);
  }

  async llmRawChat(payload) {
    return this.requestSse("/api/ide/v2/llm_raw_chat", payload);
  }
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
