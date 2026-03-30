const { parseJson } = require("./utils");

async function* iterateSseEvents(stream) {
  let buffer = "";

  for await (const chunk of stream) {
    buffer += Buffer.from(chunk).toString("utf8");

    while (true) {
      const separatorIndex = findSseSeparator(buffer);
      if (separatorIndex === -1) {
        break;
      }

      const separatorLength = buffer.startsWith("\r\n\r\n", separatorIndex) ? 4 : 2;
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + separatorLength);

      const event = parseSseEvent(rawEvent);
      if (event) {
        yield event;
      }
    }
  }

  const trailingEvent = parseSseEvent(buffer);
  if (trailingEvent) {
    yield trailingEvent;
  }
}

function findSseSeparator(buffer) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  const lfIndex = buffer.indexOf("\n\n");

  if (crlfIndex === -1) {
    return lfIndex;
  }

  if (lfIndex === -1) {
    return crlfIndex;
  }

  return Math.min(crlfIndex, lfIndex);
}

function parseSseEvent(rawEvent) {
  if (!rawEvent || !rawEvent.trim()) {
    return null;
  }

  const lines = rawEvent.split(/\r?\n/);
  let eventName = "message";
  const dataParts = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      continue;
    }

    if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trimStart());
    }
  }

  return {
    event: eventName,
    data: dataParts.join("\n"),
  };
}

function extractTraeEventDelta(rawData) {
  const parsed = parseJson(rawData, null);
  if (parsed == null) {
    const content = rawData.trim();
    return {
      contentParts: content ? [content] : [],
      toolCalls: [],
      ids: {},
      finishReason: null,
    };
  }

  return {
    contentParts: uniqueStrings(collectContentParts(parsed)),
    toolCalls: collectToolCalls(parsed),
    ids: collectIds(parsed),
    finishReason: inferFinishReason(parsed),
  };
}

function collectContentParts(node, output = []) {
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
      collectContentParts(item, output);
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
        collectContentParts(node[key], output);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        collectContentParts(value, output);
      }
    }
  }

  return output;
}

function collectToolCalls(node, output = [], seen = new Set()) {
  if (node == null) {
    return output;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectToolCalls(item, output, seen);
    }
    return output;
  }

  if (typeof node !== "object") {
    return output;
  }

  const toolId = firstString(node.tool_id, node.block_id, node.id);
  const toolType = firstString(
    node.tool_type,
    node.block_type,
    node.name,
    node.function?.name,
  );

  if (toolType && (toolId || node.function || node.arguments || node.params || node.input)) {
    const key = `${toolId || ""}:${toolType}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({
        id: toolId || null,
        type: "function",
        function: {
          name: sanitizeFunctionName(toolType),
          arguments: stringifyArguments(
            firstDefined(node.arguments, node.function?.arguments, node.params, node.input),
          ),
        },
      });
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectToolCalls(value, output, seen);
    }
  }

  return output;
}

function collectIds(node, output = {}) {
  if (node == null || typeof node !== "object") {
    return output;
  }

  if (!output.session_id && typeof node.session_id === "string") {
    output.session_id = node.session_id;
  }

  if (!output.task_id && typeof node.task_id === "string") {
    output.task_id = node.task_id;
  }

  if (!output.message_id && typeof node.message_id === "string") {
    output.message_id = node.message_id;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      collectIds(value, output);
    }
  }

  return output;
}

function inferFinishReason(node) {
  if (node == null || typeof node !== "object") {
    return null;
  }

  const reason = firstString(
    node.finish_reason,
    node.finishReason,
    node.stop_reason,
    node.stopReason,
  );
  if (reason) {
    return reason;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const nestedReason = inferFinishReason(value);
      if (nestedReason) {
        return nestedReason;
      }
    }
  }

  return null;
}

function compactContentParts(parts) {
  const output = [];

  for (const part of parts) {
    const value = String(part || "").trim();
    if (!value) {
      continue;
    }

    if (output[output.length - 1] === value) {
      continue;
    }

    output.push(value);
  }

  return output;
}

function uniqueStrings(values) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

function sanitizeFunctionName(name) {
  return (
    String(name || "tool")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool"
  );
}

function stringifyArguments(value) {
  if (value == null) {
    return "{}";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

module.exports = {
  compactContentParts,
  extractTraeEventDelta,
  iterateSseEvents,
};
