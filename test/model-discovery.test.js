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
    cacheTtlMs: 0,
  });

  const models = discovery.discover();
  assert.deepEqual(
    models.map((model) => model.id),
    ["gemini-3.1-pro", "gpt-4.1"],
  );
  assert.equal(models[0].capabilities.tools, true);
});
