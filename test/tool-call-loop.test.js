const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCommitToolPayload,
  isToolResultRequest,
  mergePendingToolCalls,
} = require("../src/tool-call-loop");

test("isToolResultRequest detects tool messages", () => {
  assert.equal(isToolResultRequest([{ role: "user", content: "hi" }]), false);
  assert.equal(
    isToolResultRequest([
      { role: "assistant", content: "", tool_calls: [] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    ]),
    true,
  );
});

test("buildCommitToolPayload maps assistant tool calls and tool results", () => {
  const payload = buildCommitToolPayload({
    conversation: {
      session_id: "session-1",
      conversation_id: "conversation-1",
      last_task_id: "task-1",
      last_message_id: "message-1",
      pending_tool_calls: [
        {
          toolcall_id: "call-1",
          tool_name: "search_codebase",
          arguments: '{"query":"gateway"}',
          agent_run_id: "agent-run-1",
        },
      ],
    },
    openaiRequest: {
      user: "user-1",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "search_codebase",
                arguments: '{"query":"gateway"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "found matches",
        },
      ],
    },
  });

  assert.deepEqual(payload, {
    task_id: "task-1",
    conversation_id: "conversation-1",
    session_id: "session-1",
    message_id: "message-1",
    user_id: "user-1",
    toolcall_results: [
      {
        agent_run_id: "agent-run-1",
        toolcall_id: "call-1",
        toolcall_name: "search_codebase",
        toolcall_resp: "found matches",
        toolcall_status: "success",
        toolcall_error_message: "",
        toolcall_params: '{"query":"gateway"}',
        is_truncated: false,
        file_path: "",
      },
    ],
  });
});

test("mergePendingToolCalls keeps latest tool metadata by id", () => {
  const merged = mergePendingToolCalls(
    [
      {
        toolcall_id: "call-1",
        tool_name: "search_codebase",
        arguments: '{"query":"old"}',
      },
    ],
    [
      {
        toolcall_id: "call-1",
        tool_name: "search_codebase",
        arguments: '{"query":"new"}',
        agent_run_id: "agent-run-2",
      },
      {
        toolcall_id: "call-2",
        tool_name: "view_files",
        arguments: '{"path":"src"}',
      },
    ],
  );

  assert.deepEqual(merged, [
    {
      toolcall_id: "call-1",
      tool_name: "search_codebase",
      arguments: '{"query":"new"}',
      agent_run_id: "agent-run-2",
      file_path: "",
    },
    {
      toolcall_id: "call-2",
      tool_name: "view_files",
      arguments: '{"path":"src"}',
      agent_run_id: "",
      file_path: "",
    },
  ]);
});
