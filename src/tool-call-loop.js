function isToolResultRequest(messages) {
  return Array.isArray(messages) && messages.some((message) => message?.role === "tool");
}

function buildCommitToolPayload({ conversation, openaiRequest }) {
  if (!conversation?.last_task_id) {
    throw new Error(
      "Tool result continuation requires a stored conversation with last_task_id.",
    );
  }

  const toolMessages = collectToolMessages(openaiRequest?.messages);
  if (toolMessages.length === 0) {
    throw new Error("Request does not contain any tool result messages.");
  }

  const assistantToolCalls = indexAssistantToolCalls(openaiRequest?.messages);
  const pendingToolCalls = indexPendingToolCalls(conversation?.pending_tool_calls);
  const toolcallResults = toolMessages.map((toolMessage, index) => {
    const pendingCall = resolvePendingToolCall({
      toolMessage,
      assistantToolCalls,
      pendingToolCalls,
      fallbackIndex: index,
    });

    if (!pendingCall?.toolcall_id) {
      throw new Error(
        `Could not match tool result to a pending tool call${toolMessage.name ? ` (${toolMessage.name})` : ""}.`,
      );
    }

    const content = normalizeToolResultContent(toolMessage.content);
    const status = inferToolResultStatus(toolMessage, content);

    return {
      agent_run_id: pendingCall.agent_run_id || "",
      toolcall_id: pendingCall.toolcall_id,
      toolcall_name: pendingCall.tool_name || toolMessage.name || "",
      toolcall_resp: content,
      toolcall_status: status,
      toolcall_error_message: status === "success" ? "" : content,
      toolcall_params: pendingCall.arguments || "",
      is_truncated: false,
      file_path: pendingCall.file_path || "",
    };
  });

  return {
    task_id: conversation.last_task_id,
    conversation_id: conversation.conversation_id || conversation.session_id || "",
    session_id: conversation.session_id || "",
    message_id: conversation.last_message_id || "",
    user_id:
      normalizeString(openaiRequest?.user)
      || normalizeString(conversation?.user_id)
      || "",
    toolcall_results: toolcallResults,
  };
}

function mergePendingToolCalls(existing, incoming) {
  const byId = new Map();

  for (const toolCall of normalizePendingToolCallList(existing)) {
    byId.set(toolCall.toolcall_id, toolCall);
  }

  for (const toolCall of normalizePendingToolCallList(incoming)) {
    byId.set(toolCall.toolcall_id, {
      ...(byId.get(toolCall.toolcall_id) || {}),
      ...toolCall,
    });
  }

  return Array.from(byId.values());
}

function indexAssistantToolCalls(messages) {
  const byId = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }

    for (const toolCall of message.tool_calls) {
      const toolcallId = normalizeString(toolCall?.id);
      if (!toolcallId) {
        continue;
      }

      byId.set(toolcallId, {
        toolcall_id: toolcallId,
        tool_name: normalizeString(toolCall?.function?.name) || "tool",
        arguments: stringifyArguments(toolCall?.function?.arguments),
      });
    }
  }

  return byId;
}

function indexPendingToolCalls(toolCalls) {
  const byId = new Map();

  for (const toolCall of normalizePendingToolCallList(toolCalls)) {
    byId.set(toolCall.toolcall_id, toolCall);
  }

  return byId;
}

function collectToolMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "tool")
    .map((message) => ({
      tool_call_id: normalizeString(message.tool_call_id),
      name: normalizeString(message.name),
      content: message.content,
      status: normalizeString(message.status),
    }));
}

function resolvePendingToolCall({
  toolMessage,
  assistantToolCalls,
  pendingToolCalls,
  fallbackIndex,
}) {
  const explicitId = toolMessage.tool_call_id;
  if (explicitId) {
    return (
      pendingToolCalls.get(explicitId)
      || assistantToolCalls.get(explicitId)
      || { toolcall_id: explicitId, tool_name: toolMessage.name || "tool", arguments: "" }
    );
  }

  if (toolMessage.name) {
    const namedPending = Array.from(pendingToolCalls.values()).find(
      (toolCall) => toolCall.tool_name === toolMessage.name,
    );
    if (namedPending) {
      return namedPending;
    }

    const namedAssistant = Array.from(assistantToolCalls.values()).find(
      (toolCall) => toolCall.tool_name === toolMessage.name,
    );
    if (namedAssistant) {
      return namedAssistant;
    }
  }

  const pendingValues = Array.from(pendingToolCalls.values());
  if (pendingValues.length === 1) {
    return pendingValues[0];
  }

  return pendingValues[fallbackIndex] || null;
}

function normalizePendingToolCallList(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .map((toolCall) => ({
      toolcall_id: normalizeString(toolCall?.toolcall_id || toolCall?.id),
      tool_name: normalizeString(toolCall?.tool_name || toolCall?.name),
      arguments: stringifyArguments(toolCall?.arguments),
      agent_run_id: normalizeString(toolCall?.agent_run_id),
      file_path: normalizeString(toolCall?.file_path),
    }))
    .filter((toolCall) => toolCall.toolcall_id);
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return content == null ? "" : JSON.stringify(content);
  }

  const textParts = [];
  const otherParts = [];

  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
      continue;
    }

    if (part?.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
      continue;
    }

    otherParts.push(part);
  }

  if (textParts.length > 0 && otherParts.length === 0) {
    return textParts.join("\n");
  }

  if (textParts.length > 0) {
    return JSON.stringify({
      text: textParts.join("\n"),
      parts: otherParts,
    });
  }

  return JSON.stringify(content);
}

function inferToolResultStatus(toolMessage, content) {
  if (toolMessage.status === "error") {
    return "error";
  }

  if (toolMessage.status === "success") {
    return "success";
  }

  if (!content.trim()) {
    return "error";
  }

  return "success";
}

function stringifyArguments(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCommitToolPayload,
  isToolResultRequest,
  mergePendingToolCalls,
};
