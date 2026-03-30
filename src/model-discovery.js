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
    this.stateDbPath =
      options.stateDbPath ||
      path.join(
        process.env.APPDATA || "C:\\Users\\Admin\\AppData\\Roaming",
        "Trae",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    this.sqliteOpen = options.sqliteOpen || defaultSqliteOpen;
    this.cacheTtlMs = options.cacheTtlMs || 30000;
    this.cache = null;
  }

  discover() {
    if (this.cache && Date.now() - this.cache.createdAt < this.cacheTtlMs) {
        return this.cache.value;
    }

    const discoveredModels = this.mergeModels(
      this.readStateModels(),
      this.readRecentModelSignals(),
    );
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

  readStateModels() {
    if (!this.fs.existsSync(this.stateDbPath) || typeof this.sqliteOpen !== "function") {
      return [];
    }

    let database;
    try {
      database = this.sqliteOpen(this.stateDbPath);
      const rows = database
        .prepare(
          [
            "select key, value from ItemTable",
            "where key like ? or key like ? or key like ?",
          ].join(" "),
        )
        .all(
          "%_AI.agent.model.model_list_map",
          "%_ai-chat:sessionRelation:globalModelMap",
          "%_ai-chat:sessionRelation:globalModeMap",
        );

      const modelListMaps = rows.filter((row) => row.key.includes("_AI.agent.model.model_list_map"));
      const globalModelMaps = rows.filter((row) =>
        row.key.includes("_ai-chat:sessionRelation:globalModelMap")
      );
      const globalModeMaps = rows.filter((row) =>
        row.key.includes("_ai-chat:sessionRelation:globalModeMap")
      );

      const selectedModels = new Set();
      for (const row of globalModelMaps) {
        const parsed = safeJson(row.value, {});
        const selected = extractSelectedBuilderModel(parsed);
        if (selected) {
          selectedModels.add(selected);
        }
      }

      const selectedModes = new Map();
      for (const row of globalModeMaps) {
        const parsed = safeJson(row.value, {});
        const mode = parsed?.dev_builder;
        if (mode != null) {
          selectedModes.set("dev_builder", Number(mode));
        }
      }

      const models = new Map();
      for (const row of modelListMaps) {
        const parsed = safeJson(row.value, {});
        for (const [scene, entries] of Object.entries(parsed)) {
          if (!Array.isArray(entries)) {
            continue;
          }

          for (const entry of entries) {
            const id = getModelId(entry);
            if (!id) {
              continue;
            }

            const current = models.get(id) || {
              id,
              object: "model",
              owned_by: "trae",
              scenes: [],
            };

            current.display_name = entry.display_name || current.display_name;
            current.provider = entry.provider || current.provider;
            current.model_type = entry.model_type || current.model_type;
            current.context_window_size = entry.context_window_size || current.context_window_size;
            current.max_tokens = entry.prompt_max_tokens || current.max_tokens;
            current.config_source = entry.config_source || current.config_source;
            current.is_preset = entry.is_preset ?? current.is_preset;
            current.selected = current.selected || selectedModels.has(id);
            current.mode = current.mode || resolveModeName(selectedModes.get("dev_builder"));
            current.capabilities = {
              ...(current.capabilities || {}),
              reasoning: Boolean(entry.features?.reasoning?.supported),
              multimodal: Boolean(entry.features?.multimodal?.supported),
              tools:
                Boolean(entry.features?.memory?.supported)
                || scene === "builder"
                || scene === "solo_coder",
            };

            if (!current.scenes.includes(scene)) {
              current.scenes.push(scene);
            }

            models.set(id, current);
          }
        }
      }

      return Array.from(models.values()).sort(compareDiscoveredModels);
    } catch {
      return [];
    } finally {
      try {
        database?.close?.();
      } catch {
        // Best-effort close for optional sqlite implementations.
      }
    }
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

  mergeModels(...groups) {
    const merged = new Map();

    for (const group of groups) {
      for (const entry of Array.isArray(group) ? group : []) {
        if (!entry?.id) {
          continue;
        }

        const current = merged.get(entry.id) || {
          id: entry.id,
          object: "model",
          owned_by: "trae",
        };

        merged.set(entry.id, mergeModelEntries(current, entry));
      }
    }

    return Array.from(merged.values()).sort(compareDiscoveredModels);
  }
}

function compareDiscoveredModels(left, right) {
  if (Boolean(left?.selected) !== Boolean(right?.selected)) {
    return left?.selected ? -1 : 1;
  }

  if (Array.isArray(left?.scenes) !== Array.isArray(right?.scenes)) {
    return Array.isArray(left?.scenes) ? -1 : 1;
  }

  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function mergeModelEntries(current, next) {
  return {
    ...current,
    ...next,
    capabilities: {
      ...(current.capabilities || {}),
      ...(next.capabilities || {}),
    },
    scenes: mergeStringLists(current.scenes, next.scenes),
    selected: Boolean(current.selected || next.selected),
  };
}

function mergeStringLists(left, right) {
  const values = new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]);
  return values.size > 0 ? Array.from(values) : undefined;
}

function getModelId(entry) {
  if (typeof entry?.name === "string" && entry.name.trim()) {
    return entry.name.trim();
  }

  if (typeof entry?.config_name === "string" && entry.config_name.trim()) {
    return entry.config_name.trim();
  }

  if (typeof entry?.model_name === "string" && entry.model_name.trim()) {
    return entry.model_name.trim();
  }

  return "";
}

function extractSelectedBuilderModel(modelMap) {
  const raw = typeof modelMap?.dev_builder === "string" ? modelMap.dev_builder : "";
  if (!raw) {
    return "";
  }

  const parts = raw.split("_-_");
  return parts[parts.length - 1] || raw;
}

function resolveModeName(modeValue) {
  if (modeValue === 0) {
    return "manual";
  }

  if (modeValue === 1) {
    return "max";
  }

  return undefined;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function defaultSqliteOpen(filePath) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(filePath, { readonly: true });
  } catch {
    return null;
  }
}

module.exports = {
  ModelDiscovery,
};
