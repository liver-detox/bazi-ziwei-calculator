import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const vitestEntry = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const internalAssets = [
  "release/test-provenance.json",
  "vitest.integration.config.ts",
  "test/review-integration.test.ts"
];

function defaultHasAsset(path) {
  return existsSync(resolve(projectRoot, path));
}

export function runOptionalInternalSuite({
  hasAsset = defaultHasAsset,
  spawnProcess = spawnSync,
  writeOutput = (value) => process.stdout.write(value)
} = {}) {
  let states;
  try {
    states = internalAssets.map((path) => hasAsset(path));
  } catch {
    writeOutput("INTERNAL_SUITE_STATE_INVALID\n");
    return 1;
  }

  if (states.every((state) => state === false)) {
    writeOutput("INTERNAL_SUITE_NOT_INCLUDED use npm run test:release\n");
    return 0;
  }
  if (!states.every((state) => state === true)) {
    writeOutput("INTERNAL_SUITE_STATE_INVALID\n");
    return 1;
  }

  try {
    const result = spawnProcess(process.execPath, [
      vitestEntry,
      "run",
      "--config",
      "vitest.integration.config.ts"
    ], { stdio: "inherit" });
    return result.status === 0 ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runOptionalInternalSuite();
}
