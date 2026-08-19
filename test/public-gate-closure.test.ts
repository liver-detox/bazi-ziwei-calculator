import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type PublicFilesManifest = {
  schemaVersion: "1.0.0";
  files: string[];
};

const projectRoot = resolve(import.meta.dirname, "..");
const publicConfigPath = resolve(projectRoot, "vitest.public.config.ts");
const publicCorrectnessTests = [
  "test/chart-document-export.test.ts",
  "test/cli-synthetic-regression.test.ts",
  "test/synthetic-demo-cases.test.ts",
  "test/public-gate-closure.test.ts",
  "test/local-browser-open.test.ts",
  "test/public-branding.test.ts",
  "test/public-docs.test.ts"
];
const requiredPublicAssets = [
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/workflows/ci.yml",
  "docs/examples/chart-document-v1.json",
  "scripts/run-optional-internal-suite.mjs",
  "scripts/run-performance-benchmarks.mjs",
  "scripts/start-local.cmd",
  "test/smoke.mjs",
  ...publicCorrectnessTests,
  "test/performance/public-synthetic-performance.test.ts",
  "test/helpers/synthetic-demo-cases.ts",
  "src/core/workbench/chart-document.ts"
];

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("public candidate gate closure", () => {
  it("selects only the declared public correctness tests without Git discovery", async () => {
    expect(existsSync(publicConfigPath), "vitest.public.config.ts must exist").toBe(true);
    if (!existsSync(publicConfigPath)) return;

    const config = (await import(`${publicConfigPath}?public-gate-closure`)).default;
    expect(config.test?.include).toEqual(publicCorrectnessTests);
    expect(config.test?.include).not.toContain("test/test-provenance-policy.test.ts");
    expect(config.test?.include).not.toContain("test/review-integration.test.ts");
    expect(config.test?.include).not.toContain("test/performance/**/*.test.ts");
  });

  it("keeps every public command on its declared public-only boundary", async () => {
    const packageJson = await readJson<{ scripts: Record<string, string> }>(
      resolve(projectRoot, "package.json")
    );

    expect(packageJson.scripts["test:public"])
      .toBe("npm test && vitest run --config vitest.public.config.ts");
    expect(packageJson.scripts["test:release"])
      .toBe("npm run test:public && npm run typecheck && npm run build");
    expect(packageJson.scripts["test:performance"])
      .toBe("vitest run --config vitest.performance.config.ts test/performance/public-synthetic-performance.test.ts --disableConsoleIntercept");
    expect(packageJson.scripts["test:performance:internal"])
      .toBe("node scripts/run-performance-benchmarks.mjs");
    expect(packageJson.scripts["test:all"])
      .toBe("npm run test:correctness && npm run typecheck && npm run build");

    expect(packageJson.scripts["test:public"]).not.toMatch(/integration|performance|provenance|git/iu);
    expect(packageJson.scripts["test:release"]).not.toMatch(/integration|performance|provenance|git/iu);
  });

  it("ships the complete public gate dependency closure without the source-only provenance inventory", async () => {
    const manifest = await readJson<PublicFilesManifest>(
      resolve(projectRoot, "release/public-files.json")
    );
    for (const path of requiredPublicAssets) {
      expect(manifest.files, `${path} must be copied`).toContain(path);
    }
    expect(manifest.files).not.toContain("release/test-provenance.json");
    expect(manifest.files).not.toContain("test/test-provenance-policy.test.ts");
  });
});
