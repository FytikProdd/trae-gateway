const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");

const { compactContentParts, extractTraeEventDelta, iterateSseEvents } = require("../src/sse");

test("iterateSseEvents parses mixed newline separators", async () => {
  const stream = Readable.from([
    'event: chunk\r\ndata: {"text":"hello"}\r\n\r\n',
    'data: {"text":"world"}\n\n',
  ]);

  const events = [];
  for await (const event of iterateSseEvents(stream)) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { event: "chunk", data: '{"text":"hello"}' },
    { event: "message", data: '{"text":"world"}' },
  ]);
});

test("extractTraeEventDelta returns tool calls and ids", () => {
  const delta = extractTraeEventDelta(
    JSON.stringify({
      session_id: "session-1",
      task_id: "task-1",
      message_id: "message-1",
      tool_type: "run_command",
      tool_id: "tool-1",
      input: { command: "npm test" },
    }),
  );

  assert.deepEqual(delta.toolCalls, [
    {
      id: "tool-1",
      type: "function",
      function: {
        name: "run_command",
        arguments: '{"command":"npm test"}',
      },
    },
  ]);
  assert.deepEqual(delta.ids, {
    session_id: "session-1",
    task_id: "task-1",
    message_id: "message-1",
  });
});

test("compactContentParts removes only consecutive duplicates", () => {
  assert.deepEqual(compactContentParts(["hello", "hello", "world", "hello"]), [
    "hello",
    "world",
    "hello",
  ]);
});
