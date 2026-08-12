import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const excludedPaths = [
  "test/golden-cases.test.ts",
  "test/pilot-cases.test.ts",
  "test/cli-regression.test.ts"
];
const genericPrivatePathPatterns = [
  /\/Users\/[^/\s"']+/u,
  /\/home\/[^/\s"']+/u,
  /[A-Za-z]:\\+Users\\+[^\\\s"']+/u,
  /\btest[\\/][^\s"']+\.(?:ts|tsx|mjs|js)\b/u
];

test("the public synthetic CLI example emits the stable chart contract", () => {
  const result = spawnSync(process.execPath, [
    "src/ziwei-chart.mjs",
    "--solar", "2000-01-15",
    "--time", "12:00",
    "--gender", "女",
    "--name", "DEMO-NORMAL",
    "--format", "json"
  ], { cwd: projectRoot, encoding: "utf8" });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(excludedPaths[0]);
  expect(result.stdout).not.toContain(excludedPaths[1]);
  expect(result.stdout).not.toContain(excludedPaths[2]);
  for (const pattern of genericPrivatePathPatterns) {
    expect(result.stdout).not.toMatch(pattern);
    expect(result.stderr).not.toMatch(pattern);
  }

  const data = JSON.parse(result.stdout) as {
    schemaVersion?: string;
    chart: { chineseDate: string; palaces: Array<{ name: string }> };
  };

  expect(data.schemaVersion).toBe("1.0.0");
  expect(data.chart.chineseDate).toBe("己卯 丁丑 壬申 丙午");
  expect(data.chart.palaces.map((palace) => palace.name)).toEqual([
    "疾厄", "财帛", "子女", "夫妻", "兄弟", "命宫",
    "父母", "福德", "田宅", "官禄", "仆役", "迁移"
  ]);
});
