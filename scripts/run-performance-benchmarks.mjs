import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const vitestEntry = resolve(
  dirname(requireFromHere.resolve("vitest/package.json")),
  "vitest.mjs"
);
const benchmarkFiles = [
  "test/performance/provided-time-performance.test.ts",
  "test/performance/review-performance.test.ts"
];

export function runPerformanceBenchmarks(spawnProcess) {
  let failed = false;
  for (const benchmarkFile of benchmarkFiles) {
    const result = spawnProcess(process.execPath, [
      vitestEntry,
      "run",
      "--config",
      "vitest.performance.config.ts",
      benchmarkFile,
      "--disableConsoleIntercept"
    ], { stdio: "inherit" });
    if (result.status !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

const internalAssets = [
  "release/test-provenance.json",
  ...benchmarkFiles
];

function defaultHasAsset(path) {
  return existsSync(resolve(projectRoot, path));
}

export function runOptionalPerformanceBenchmarks({
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
    writeOutput("INTERNAL_SUITE_NOT_INCLUDED use npm run test:performance\n");
    return 0;
  }
  if (!states.every((state) => state === true)) {
    writeOutput("INTERNAL_SUITE_STATE_INVALID\n");
    return 1;
  }
  return runPerformanceBenchmarks(spawnProcess);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runOptionalPerformanceBenchmarks();
}
