const fs = require("node:fs");
const path = require("node:path");

class SessionStore {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.filePath =
      options.filePath || path.resolve(process.cwd(), ".trae-gateway-sessions.json");
    this.state = null;
  }

  getConversation(key) {
    if (!key) {
      return null;
    }

    const state = this.readState();
    return state.conversations[key] || null;
  }

  upsertConversation(key, value) {
    if (!key) {
      return null;
    }

    const state = this.readState();
    const nextValue = {
      ...(state.conversations[key] || {}),
      ...value,
      updated_at: new Date().toISOString(),
    };

    state.conversations[key] = nextValue;
    this.writeState(state);
    return nextValue;
  }

  ensureConversation(key, createValue) {
    const existing = this.getConversation(key);
    if (existing) {
      return existing;
    }

    const initialValue = typeof createValue === "function" ? createValue() : createValue;
    return this.upsertConversation(key, initialValue);
  }

  readState() {
    if (this.state) {
      return this.state;
    }

    if (!this.fs.existsSync(this.filePath)) {
      this.state = { conversations: {} };
      return this.state;
    }

    const raw = this.fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw);
    this.state = {
      conversations:
        parsed?.conversations && typeof parsed.conversations === "object"
          ? parsed.conversations
          : {},
    };
    return this.state;
  }

  writeState(nextState) {
    const directory = path.dirname(this.filePath);
    if (!this.fs.existsSync(directory)) {
      this.fs.mkdirSync(directory, { recursive: true });
    }

    this.state = nextState;
    this.fs.writeFileSync(this.filePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }
}

function deriveConversationKey(openaiRequest, headers = {}) {
  const candidates = [
    openaiRequest?.metadata?.conversation_id,
    openaiRequest?.metadata?.thread_id,
    openaiRequest?.conversation_id,
    headers["x-trae-conversation-id"],
    headers["x-openai-conversation-id"],
    openaiRequest?.user,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

module.exports = {
  SessionStore,
  deriveConversationKey,
};
