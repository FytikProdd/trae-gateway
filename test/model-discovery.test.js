const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ModelDiscovery } = require("../src/model-discovery");

test("ModelDiscovery reads recent models from renderer logs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trae-gateway-logs-"));
  const logDir = path.join(tempDir, "20260330T223703", "window1");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "renderer.log"),
    [
      '2026 [info] event: tool_call_show ; params: {"chat_model":"gemini-3.1-pro"}',
      '2026 [info] event: message ; params: {"chat_model":"gpt-4.1"}',
    ].join("\n"),
    "utf8",
  );

  const discovery = new ModelDiscovery({
    logsPath: tempDir,
    stateDbPath: path.join(tempDir, "missing-state.vscdb"),
    cacheTtlMs: 0,
  });

  const models = discovery.discover();
  assert.deepEqual(
    models.map((model) => model.id),
    ["gemini-3.1-pro", "gpt-4.1"],
  );
  assert.equal(models[0].capabilities.tools, true);
});

test("ModelDiscovery prefers selected models from state.vscdb when sqlite is available", () => {
  const discovery = new ModelDiscovery({
    logsPath: path.join(os.tmpdir(), "missing-logs"),
    stateDbPath: path.join(os.tmpdir(), "fake-state.vscdb"),
    cacheTtlMs: 0,
    fs: {
      ...fs,
      existsSync(targetPath) {
        return targetPath.endsWith("fake-state.vscdb");
      },
    },
    sqliteOpen() {
      return {
        prepare() {
          return {
            all() {
              return [
                {
                  key: "7623057245782295573_AI.agent.model.model_list_map",
                  value: JSON.stringify({
                    builder: [
                      {
                        config_name: "gemini-3.1-pro",
                        display_name: "Gemini 3.1 Pro",
                        config_source: 1,
                        is_preset: true,
                        features: {
                          reasoning: { supported: true },
                          multimodal: { supported: true },
                        },
                      },
                      {
                        config_name: "gpt-5.3-codex",
                        display_name: "GPT-5.3 Codex",
                        config_source: 1,
                        is_preset: true,
                        features: {
                          reasoning: { supported: true },
                          multimodal: { supported: false },
                        },
                      },
                    ],
                    solo_coder: [
                      {
                        config_name: "gemini-3.1-pro",
                        display_name: "Gemini 3.1 Pro",
                        config_source: 1,
                        is_preset: true,
                        features: {
                          reasoning: { supported: true },
                          multimodal: { supported: true },
                        },
                      },
                    ],
                  }),
                },
                {
                  key: "7623057245782295573_ai-chat:sessionRelation:globalModelMap",
                  value: JSON.stringify({
                    dev_builder: "1_-_gpt-5.3-codex",
                  }),
                },
                {
                  key: "7623057245782295573_ai-chat:sessionRelation:globalModeMap",
                  value: JSON.stringify({
                    dev_builder: 1,
                  }),
                },
              ];
            },
          };
        },
        close() {},
      };
    },
  });

  const models = discovery.discover();
  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.3-codex", "gemini-3.1-pro"],
  );
  assert.equal(models[0].selected, true);
  assert.equal(models[0].mode, "max");
  assert.deepEqual(models[1].scenes, ["builder", "solo_coder"]);
});
