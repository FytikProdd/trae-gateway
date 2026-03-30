const fs = require("node:fs");
const path = require("node:path");

class ModelDiscovery {
  constructor(options = {}) {
    this.fs = options.fs || fs;
    this.logsPath =
      options.logsPath ||
      path.join(
        process.env.USERPROFILE || "C:\\Users\\Admin",
        "AppData",
        "Roaming",
        "Trae",
        "logs",
      );
    this.cacheTtlMs = options.cacheTtlMs || 30000;
    this.cache = null;
  }

  discover() {
    if (this.cache && Date.now() - this.cache.createdAt < this.cacheTtlMs) {
      return this.cache.value;
    }

    const discoveredModels = this.readRecentModelSignals();
    const value = discoveredModels.length > 0
      ? discoveredModels
      : [
          { id: "trae-agent", object: "model", owned_by: "trae" },
          { id: "trae-raw-chat", object: "model", owned_by: "trae" },
        ];

    this.cache = {
      createdAt: Date.now(),
      value,
    };

    return value;
  }

  readRecentModelSignals() {
    if (!this.fs.existsSync(this.logsPath)) {
      return [];
    }

    const directories = this.fs
      .readdirSync(this.logsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}$/.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(this.logsPath, entry.name);
        const stats = this.fs.statSync(fullPath);
        return {
          fullPath,
          mtimeMs: stats.mtimeMs,
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, 6);

    const models = new Map();

    for (const directory of directories) {
      const rendererLogPath = path.join(directory.fullPath, "window1", "renderer.log");
      if (!this.fs.existsSync(rendererLogPath)) {
        continue;
      }

      const text = this.fs.readFileSync(rendererLogPath, "utf8");
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        const match = /"chat_model":"([^"]+)"/.exec(line);
        if (!match) {
          continue;
        }

        const id = match[1];
        const entry = models.get(id) || {
          id,
          object: "model",
          owned_by: "trae",
        };

        if (/tool_call_show|run_script_show/.test(line)) {
          entry.capabilities = {
            ...(entry.capabilities || {}),
            tools: true,
          };
        }

        models.set(id, entry);
      }
    }

    return Array.from(models.values());
  }
}

module.exports = {
  ModelDiscovery,
};
