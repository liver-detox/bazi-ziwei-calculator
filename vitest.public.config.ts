import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/chart-document-export.test.ts",
      "test/cli-synthetic-regression.test.ts",
      "test/synthetic-demo-cases.test.ts",
      "test/public-gate-closure.test.ts",
      "test/local-browser-open.test.ts",
      "test/public-branding.test.ts",
      "test/public-docs.test.ts"
    ]
  }
});
