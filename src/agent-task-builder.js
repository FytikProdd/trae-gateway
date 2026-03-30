function buildAgentTaskPayload({ openaiRequest, runtimeVars, prompt, model }) {
  const resolvedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (!resolvedPrompt) {
    throw new Error("Cannot build Trae agent payload without a prompt.");
  }

  const payload = {
    session_id: runtimeVars.session_id,
    task_id: runtimeVars.task_id,
    message_id: runtimeVars.message_id,
    query: resolvedPrompt,
    model: model || "trae-agent",
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

function normalizeTools(tools) {
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

module.exports = {
  buildAgentTaskPayload,
  normalizeTools,
};
