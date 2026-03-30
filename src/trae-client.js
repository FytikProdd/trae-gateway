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
    }, { service: "ide" });
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
}

function isRetryableUpstreamMiss(status) {
  return status === 404 || status === 405;
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
