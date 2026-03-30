const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAgentTaskPayload, normalizeTools } = require("../src/agent-task-builder");
const { flattenMessages } = require("../src/utils");

test("buildAgentTaskPayload constructs a minimal agent-v3 request", () => {
  const openaiRequest = {
    model: "trae-agent",
    messages: [
      { role: "system", content: "You are precise." },
      { role: "user", content: "Explain the current architecture." },
    ],
  };
  const prompt = flattenMessages(openaiRequest.messages);

  const payload = buildAgentTaskPayload({
    openaiRequest,
    prompt,
    model: openaiRequest.model,
    runtimeVars: {
      session_id: "session-1",
      conversation_id: "conversation-1",
      task_id: "task-1",
      message_id: "message-1",
      trace_id: "trace-1",
      request_id: "request-1",
    },
    profile: {
      userId: "user-1",
      deviceId: "device-1",
      ideVersion: "3.5.42",
      pluginChannel: "stable",
      defaultModel: "gemini-3.1-pro",
      defaultConfigName: "gemini-3.1-pro",
      appLanguage: "en-US",
    },
  });

  assert.deepEqual(payload, {
    session_id: "session-1",
    conversation_id: "conversation-1",
    task_id: "task-1",
    message_id: "message-1",
    query: "SYSTEM:\nYou are precise.\n\nUSER:\nExplain the current architecture.",
    model: "gemini-3.1-pro",
    user_id: "user-1",
    device_id: "device-1",
    agent_type: "builder_v3",
    model_name: "gemini-3.1-pro",
    config_name: "gemini-3.1-pro",
    ide_version: "3.5.42",
    plugin_channel: "stable",
    available_tool_list: [],
    user_input: {
      id: "message-1",
      messages: [
        {
          type: "text",
          text_content: "SYSTEM:\nYou are precise.\n\nUSER:\nExplain the current architecture.",
        },
      ],
    },
    render_context: {
      variables: JSON.stringify({
        prompt: "SYSTEM:\nYou are precise.\n\nUSER:\nExplain the current architecture.",
        messages: [
          { role: "system", content: "You are precise." },
          { role: "user", content: "Explain the current architecture." },
        ],
        ide_language: "en",
      }),
      references: {},
    },
    metadata: {
      client: "trae-gateway",
      trace_id: "trace-1",
      request_id: "request-1",
    },
  });
});

test("buildAgentTaskPayload preserves supported OpenAI tool metadata", () => {
  const payload = buildAgentTaskPayload({
    openaiRequest: {
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file from disk.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        },
        { type: "code_interpreter" },
      ],
      tool_choice: "auto",
      temperature: 0.2,
    },
    prompt: "USER:\nRun the tool.",
    model: "trae-agent",
    runtimeVars: {
      session_id: "session-1",
      conversation_id: "conversation-1",
      task_id: "task-1",
      message_id: "message-1",
      trace_id: "trace-1",
      request_id: "request-1",
    },
    profile: {
      userId: "user-1",
      deviceId: "device-1",
      ideVersion: "3.5.42",
      pluginChannel: "stable",
      defaultModel: "gemini-3.1-pro",
      defaultConfigName: "gemini-3.1-pro",
      appLanguage: "en-US",
    },
  });

  assert.deepEqual(payload.metadata.openai_tools, [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from disk.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    },
  ]);
  assert.equal(payload.metadata.openai_tool_choice, "auto");
  assert.equal(payload.metadata.openai_temperature, 0.2);
});

test("normalizeTools drops unsupported tools and fills missing parameter schema", () => {
  assert.deepEqual(
    normalizeTools([
      {
        type: "function",
        function: {
          name: "ping",
        },
      },
      {
        type: "function",
        function: {},
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "ping",
          description: "",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    ],
  );
});
