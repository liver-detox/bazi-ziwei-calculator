import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildLocalServer } from "./app.js";
import {
  localBrowserOpenCommand,
  monitorLocalBrowserOpen
} from "./local-browser-open.js";
import { registerWorkbenchRoutes } from "./workbench-routes.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const staticRoot = fileURLToPath(new URL("../../dist/", import.meta.url));
const dataRoot = resolve(process.env.CYBER_SAGA_DATA_DIR ?? fileURLToPath(new URL("../../data/", import.meta.url)));
await mkdir(dataRoot, { recursive: true, mode: 0o700 });

const configuredPort = process.env.CYBER_SAGA_PORT;
const port = configuredPort === undefined ? 0 : Number(configuredPort);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("CYBER_SAGA_PORT 必须是 0–65535 的整数");
}

const app = await buildLocalServer({
  staticRoot,
  dataRoot,
  registerRoutes: async (instance) => {
    await registerWorkbenchRoutes(instance, { dataRoot });
  }
});
const address = await app.listen({ host: "127.0.0.1", port });
const localUrl = address.replace("0.0.0.0", "127.0.0.1");

process.stdout.write(`赛博大师·八字与紫微排盘计算器已启动：${localUrl}\n`);
process.stdout.write(`案例数据：${dataRoot}\n`);

const openCommand = localBrowserOpenCommand(
  process.platform,
  localUrl,
  process.env.CYBER_SAGA_NO_OPEN === "1"
);
if (openCommand !== null) {
  const opener = spawn(openCommand.command, openCommand.args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore"
  });
  monitorLocalBrowserOpen(opener, (message) => process.stderr.write(`${message}\n`));
}
