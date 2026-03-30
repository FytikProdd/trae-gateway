const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionStore, deriveConversationKey } = require("../src/session-store");

test("SessionStore persists conversation state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-session-"));
  const filePath = path.join(tempDir, "sessions.json");
  const store = new SessionStore({ filePath });

  store.upsertConversation("thread-1", {
    session_id: "session-1",
    turn_count: 1,
  });

  const reloaded = new SessionStore({ filePath });
  assert.deepEqual(reloaded.getConversation("thread-1").session_id, "session-1");
  assert.equal(reloaded.getConversation("thread-1").turn_count, 1);
});

test("deriveConversationKey prefers explicit metadata", () => {
  assert.equal(
    deriveConversationKey(
      {
        metadata: {
          conversation_id: "chat-123",
        },
        user: "fallback-user",
      },
      { "x-trae-conversation-id": "header-chat" },
    ),
    "chat-123",
  );
});
