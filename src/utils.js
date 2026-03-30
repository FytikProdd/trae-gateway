const crypto = require("node:crypto");

function parseJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function loadJsonFile(fs, filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createObjectId() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
  return `${ts}${createHex(8)}`;
}

function createTraceId() {
  return createHex(16);
}

function createRequestId() {
  return crypto.randomUUID();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function deepReplace(value, replacements) {
  if (typeof value === "string") {
    let out = value;
    for (const [key, replacement] of Object.entries(replacements)) {
      out = out.split(`{{${key}}}`).join(String(replacement));
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepReplace(item, replacements));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, deepReplace(child, replacements)]),
    );
  }

  return value;
}

function flattenMessages(messages) {
  if (!Array.isArray(messages)) {
    return "";
  }

  const parts = [];

  for (const message of messages) {
    const role = message?.role || "user";
    const content = normalizeMessageContent(message?.content);
    if (!content) {
      continue;
    }
    parts.push(`${role.toUpperCase()}:\n${content}`);
  }

  return parts.join("\n\n");
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }

    if (item?.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }

  return parts.join("\n");
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body, null, 2));
}

function text(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

function sanitizeAuthInfo(authInfo) {
  if (!authInfo) {
    return null;
  }

  const token = authInfo.token || "";
  const refreshToken = authInfo.refreshToken || "";

  return {
    host: authInfo.host || null,
    userId: authInfo.userId || null,
    expiredAt: authInfo.expiredAt || null,
    refreshExpiredAt: authInfo.refreshExpiredAt || null,
    tokenReleaseAt: authInfo.tokenReleaseAt || null,
    tokenPreview: token ? `${token.slice(0, 16)}...${token.slice(-8)}` : null,
    refreshTokenPreview: refreshToken ? `${refreshToken.slice(0, 12)}...${refreshToken.slice(-6)}` : null,
  };
}

function collectTextCandidates(node, output = []) {
  if (node == null) {
    return output;
  }

  if (typeof node === "string") {
    if (node.trim()) {
      output.push(node);
    }
    return output;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectTextCandidates(item, output);
    }
    return output;
  }

  if (typeof node === "object") {
    const preferredKeys = [
      "content",
      "text",
      "delta",
      "answer",
      "message",
      "reasoning",
      "thought",
      "output_text",
      "display_content",
      "displayContent",
    ];

    for (const key of preferredKeys) {
      if (key in node) {
        collectTextCandidates(node[key], output);
      }
    }

    for (const value of Object.values(node)) {
      if (typeof value === "object") {
        collectTextCandidates(value, output);
      }
    }
  }

  return output;
}

function extractTextFromTraeEvent(rawData) {
  const parsed = parseJson(rawData, null);
  if (parsed == null) {
    return rawData.trim() ? rawData : "";
  }

  const candidates = collectTextCandidates(parsed);
  const unique = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const normalized = String(candidate).trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }

  return unique.join("\n");
}

module.exports = {
  createObjectId,
  createRequestId,
  createTraceId,
  deepReplace,
  extractTextFromTraeEvent,
  flattenMessages,
  json,
  loadJsonFile,
  nowUnix,
  parseJson,
  sanitizeAuthInfo,
  sseHeaders,
  text,
};
