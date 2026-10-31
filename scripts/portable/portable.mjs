import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("NODE_24_REQUIRED");
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--check")) {
    throw new Error("Usage: Start.cmd [--check]");
  }
  for (const path of ["./dist/index.html", "./src/server/index.js", "./node_modules/fastify/package.json"]) {
    await access(new URL(path, import.meta.url));
  }
  if (process.argv[2] === "--check") {
    process.stdout.write("PORTABLE_LAYOUT_OK (not a Windows/browser acceptance test)\n");
  } else {
    process.chdir(fileURLToPath(new URL("./", import.meta.url)));
    process.env.CYBER_SAGA_DATA_DIR ??= fileURLToPath(new URL("../data/", import.meta.url));
    await mkdir(process.env.CYBER_SAGA_DATA_DIR, { recursive: true, mode: 0o700 });
    await access(process.env.CYBER_SAGA_DATA_DIR, constants.W_OK);
    process.stdout.write("Keep this window open. Press Ctrl+C to stop.\n");
    await import("./src/server/index.js");
  }
} catch (error) {
  process.stderr.write(`Portable startup failed: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
}
