function buildAgentTaskPayload({ openaiRequest, runtimeVars, prompt, model, profile = {} }) {
  const resolvedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!resolvedPrompt) {
    throw new Error("Cannot build Trae agent payload without a prompt.");
  }

  const resolvedModelName = resolveModelName(model, profile.defaultModel);
  const language = normalizeLanguageCode(profile.appLanguage);
  const payload = {
    session_id: runtimeVars.session_id,
    task_id: runtimeVars.task_id,
    message_id: runtimeVars.message_id,
    conversation_id: runtimeVars.conversation_id || runtimeVars.session_id,
    query: resolvedPrompt,
    model: resolvedModelName,
    user_id: profile.userId || "",
    device_id: profile.deviceId || "",
    agent_type: profile.agentType || "builder_v3",
    model_name: resolvedModelName,
    config_name: resolveConfigName(openaiRequest, profile, resolvedModelName),
    ide_version: profile.ideVersion || "",
    plugin_channel: profile.pluginChannel || "unknown",
    available_tool_list: normalizeAvailableTools(openaiRequest?.tools),
    user_input: {
      id: runtimeVars.message_id,
      messages: [
        {
          type: "text",
          text_content: resolvedPrompt,
        },
      ],
    },
    render_context: {
      variables: JSON.stringify({
        prompt: resolvedPrompt,
        messages: normalizeMessages(openaiRequest?.messages),
        ide_language: language,
      }),
      references: {},
    },
    metadata: {
      client: "trae-gateway",
      trace_id: runtimeVars.trace_id,
      request_id: runtimeVars.request_id,
    },
  };

  if (Array.isArray(openaiRequest?.tools) && openaiRequest.tools.length > 0) {
    payload.metadata.openai_tools = normalizeTools(openaiRequest.tools);
  }

  if (openaiRequest?.tool_choice != null) {
    payload.metadata.openai_tool_choice = openaiRequest.tool_choice;
  }

  if (typeof openaiRequest?.temperature === "number") {
    payload.metadata.openai_temperature = openaiRequest.temperature;
  }

  return payload;
}

function resolveModelName(model, defaultModel) {
  const candidate = typeof model === "string" ? model.trim() : "";
  if (!candidate || candidate === "trae-agent") {
    return defaultModel || "gemini-3.1-pro";
  }

  return candidate;
}

function resolveConfigName(openaiRequest, profile, resolvedModelName) {
  const requestConfigName = typeof openaiRequest?.config_name === "string"
    ? openaiRequest.config_name.trim()
    : "";
  if (requestConfigName) {
    return requestConfigName;
  }

  const profileConfigName = typeof profile?.defaultConfigName === "string"
    ? profile.defaultConfigName.trim()
    : "";
  if (profileConfigName) {
    return profileConfigName;
  }

  return resolvedModelName;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .filter((tool) => tool?.type === "function" && tool.function?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.function.name,
        description: typeof tool.function.description === "string" ? tool.function.description : "",
        parameters:
          tool.function.parameters && typeof tool.function.parameters === "object"
            ? tool.function.parameters
            : { type: "object", properties: {} },
      },
    }));
}

function normalizeAvailableTools(tools) {
  return normalizeTools(tools).map((tool) => tool.function.name);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => ({
      role: message?.role || "user",
      content: normalizeMessageText(message?.content),
    }))
    .filter((message) => message.content);
}

function normalizeMessageText(content) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }

      if (item?.type === "text" && typeof item.text === "string") {
        return item.text.trim();
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeLanguageCode(language) {
  const value = typeof language === "string" ? language.trim().toLowerCase() : "";
  if (!value) {
    return "en";
  }

  return value.slice(0, 2);
}

module.exports = {
  buildAgentTaskPayload,
  normalizeAvailableTools,
  normalizeTools,
};
