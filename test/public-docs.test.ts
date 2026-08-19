import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ChartDocumentV1Schema } from "../src/core/workbench/chart-document.js";

const publicDocuments = [
  "README.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md"
] as const;
const examplePath = "docs/examples/chart-document-v1.json";

async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("public documentation artifacts", () => {
  it("ships the complete minimum public document set", async () => {
    const contents = await Promise.all(publicDocuments.map(read));

    expect(contents).toHaveLength(publicDocuments.length);
    for (const content of contents) expect(content.trim().length).toBeGreaterThan(0);
  });

  it("ships a complete, internally consistent ChartDocument v1 example", async () => {
    const example = ChartDocumentV1Schema.parse(JSON.parse(await read(examplePath)));
    const packageJson = JSON.parse(await read("package.json")) as { version: string };
    const candidateId = example.selection.candidateId;

    expect(example.calculatorVersion).toBe(packageJson.version);
    expect(example.bazi.chart.candidateId).toBe(candidateId);
    expect(example.bazi.detail.candidate.candidateId).toBe(candidateId);
    expect(example.ziwei.candidateId).toBe(candidateId);
    expect("candidates" in example.bazi.detail).toBe(false);
  });
});
