const path = require("node:path");

const { createConfig, createGateway, loadDotEnv } = require("./app");

loadDotEnv(path.resolve(process.cwd(), ".env"));

const config = createConfig();
const { server, trae } = createGateway(config);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Trae gateway listening on http://127.0.0.1:${config.port}`);
  console.log(`Mode: ${config.mode}`);

  try {
    console.log(`Trae base: ${trae.getBaseDomain("agent")}`);
  } catch (error) {
    console.log(
      `Trae base: unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
});
