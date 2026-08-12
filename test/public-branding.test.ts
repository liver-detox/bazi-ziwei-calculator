import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const publicProductFiles = [
  "package.json",
  "index.html",
  "src/web/App.tsx",
  "src/server/index.ts",
  "scripts/start-local.command",
  "src/web/export-download.ts",
  "src/core/workbench/artifacts.ts"
];

describe("public product identity", () => {
  it("uses the balanced Bazi and Ziwei name and a synthetic demo", async () => {
    const contents = await Promise.all(publicProductFiles.map((path) => readFile(path, "utf8")));
    const joined = contents.join("\n");

    expect(joined).not.toContain("ziwei-local");
    expect(joined).not.toContain("本地双轨排盘与审计器");
    expect(joined).toContain("赛博大师·八字与紫微排盘计算器");
    expect(JSON.parse(contents[0]).name).toBe("bazi-ziwei-calculator");
    expect(JSON.parse(contents[0]).private).toBe(true);
    expect(JSON.parse(contents[0]).scripts.demo).toContain("DEMO-NORMAL");
  });
});
