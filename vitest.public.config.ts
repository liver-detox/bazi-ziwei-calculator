import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/chart-document-export.test.ts",
      "test/web-chart-document-text.test.ts",
      "test/web-export-download.test.ts",
      "test/web-export-orchestration.test.ts",
      "test/web-chart-document-printout.test.tsx",
      "test/web-result-drawers.test.tsx",
      "test/cli-synthetic-regression.test.ts",
      "test/synthetic-demo-cases.test.ts",
      "test/ziwei-capability-equivalence.test.ts",
      "test/public-gate-closure.test.ts",
      "test/local-browser-open.test.ts",
      "test/public-branding.test.ts",
      "test/public-docs.test.ts"
    ]
  }
});
