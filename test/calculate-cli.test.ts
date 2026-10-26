import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { calculateDocuments, candidateDirectory, parseYears, runCalculateCli, writeDocuments } from "../src/cli/calculate.js";
import { ChartDocumentV1Schema } from "../src/core/workbench/chart-document.js";
import { presentChartDocumentText } from "../src/web/chart-document-text.js";

const demo = {
  schemaVersion: "2.0.0", caseId: "CS-2000-001", alias: "SYNTHETIC-CLI", gender: "女",
  calendar: { type: "solar", date: "2000-01-15", leapMonth: false },
  providedTime: { localTime: "12:00", basis: "civil_clock_provided", precision: "minute", sourceType: "unknown" },
  policy: { lateZi: "candidates" }
};
const options = { calculatorVersion: "0.5.0", now: new Date("2026-10-26T00:00:00Z") };
const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "synthetic-calculate-"));
  directories.push(directory);
  return directory;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    runtime: { stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } },
    output: () => stdout, error: () => stderr
  };
}

async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await filesUnder(join(directory, entry.name), path + "/"));
    else result.push(path);
  }
  return result.sort();
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("on-demand dual-track CLI", () => {
  it("keeps the public V1 example's calculated fields and the existing 50-year format", async () => {
    const old = ChartDocumentV1Schema.parse(JSON.parse(await readFile("docs/examples/chart-document-v1.json", "utf8")));
    const birthRecord = {
      schemaVersion: "2.0.0", caseId: old.selection.candidateId.split(":")[0],
      alias: old.subject.nameOrAlias, gender: old.subject.gender, ...old.birthInput
    };
    const documents = calculateDocuments({ birthRecord, targetYears: old.ziwei.yearlyFortunes.map((item) => item.targetYear) }, options);
    const current = documents.find((item) => item.selection.candidateId === old.selection.candidateId)!;
    expect(current.bazi).toEqual(old.bazi);
    expect(current.ziwei).toEqual(old.ziwei);
    expect(current.bazi.detail.configuration.maxTargetYears).toBe(50);
    expect(ChartDocumentV1Schema.parse(current)).toEqual(current);
    expect(current.exportSourceId).toMatch(/^src1-[a-f0-9]{16}$/u);
  });

  it("defaults to natal and decadal data and writes nothing without --out", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "input.json");
    await writeFile(source, JSON.stringify(demo));
    const io = capture();
    expect(await runCalculateCli(["--input", source, "--format", "json"], io.runtime)).toBe(0);
    const document = ChartDocumentV1Schema.parse(JSON.parse(io.output()));
    expect(document.bazi.chart.fourPillars).toHaveLength(4);
    expect(document.ziwei.palaces).toHaveLength(12);
    expect(document.bazi.chart.luck.daYun.length).toBeGreaterThan(1);
    expect(document.bazi.chart.annualFortunes).toEqual([]);
    expect(document.bazi.detail.candidate.annualDetails).toEqual([]);
    expect(document.ziwei.yearlyFortunes).toEqual([]);
    expect(await readdir(directory)).toEqual(["input.json"]);
  });

  it("returns all four leap-month and late-Zi candidates without selecting one", () => {
    const documents = calculateDocuments({
      ...demo, calendar: { type: "lunar", date: "2023-02-01", leapMonth: "unknown" },
      providedTime: { ...demo.providedTime, localTime: "23:30" }
    }, options);
    expect(documents.map(candidateDirectory).sort()).toEqual([
      "lunar-leap-current-day", "lunar-leap-next-day", "lunar-regular-current-day", "lunar-regular-next-day"
    ]);
    for (const document of documents) {
      expect(document.selection.hadAlternatives).toBe(true);
      expect(document.selection.rationale).toBeNull();
      expect(document.warnings).toContain("本文件是并列候选之一，尚未确认取舍。");
      expect(document.bazi.chart.candidateId).toBe(document.ziwei.candidateId);
      expect(document.bazi.detail.candidate.candidateId).toBe(document.ziwei.candidateId);
    }
  });

  it("normalizes year ranges, enforces the V1 limit, and lets CLI years override input", () => {
    expect(parseYears("2028:2030,2026,2028")).toEqual([2026, 2028, 2029, 2030]);
    expect(() => parseYears("2030:2028")).toThrow("年份范围");
    expect(() => parseYears("2020:2070")).toThrow("50");
    const [document] = calculateDocuments({ birthRecord: demo, targetYears: [2026] }, { ...options, targetYears: [2028] });
    expect(document.ziwei.yearlyFortunes.map((item) => item.targetYear)).toEqual([2028]);
  });

  it("expands every requested year through the shared text renderer", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "input.json");
    await writeFile(source, JSON.stringify({ birthRecord: demo, targetYears: [2026, 2027] }));
    const io = capture();
    expect(await runCalculateCli(["--input", source], io.runtime)).toBe(0);
    expect(io.output()).toContain("2026 年度");
    expect(io.output()).toContain("2027 年度");
    expect(io.output().match(/^## 八字$/gmu)).toHaveLength(1);
    expect(io.output().match(/^## 紫微斗数$/gmu)).toHaveLength(1);
  });

  it("labels a shifted late-Zi lunar candidate by the original calendar choice", () => {
    const [document] = calculateDocuments({
      ...demo, calendar: { type: "lunar", date: "2023-02-30", leapMonth: false },
      providedTime: { ...demo.providedTime, localTime: "23:30" }, policy: { lateZi: "next_day" }
    }, options);
    expect(document.ziwei.input.engineInputDate).toBe("2023-03-22");
    expect(candidateDirectory(document)).toBe("lunar-regular-next-day");
  });

  it("retains old JSON metadata and evidence-only facts while reading without recalculation", async () => {
    const directory = await temporaryDirectory();
    const [document] = calculateDocuments(demo, { ...options, targetYears: [2026, 2027] });
    document.calculatorVersion = "0.4.0";
    document.targetYear = 2026;
    document.evidence = {
      auditLevel: "C", workflowStatus: "review", allowedAnalysisModes: ["data_diagnosis"],
      findings: [{ code: "TIME_EVIDENCE_INCOMPLETE", severity: "warning", summary: "出生分钟尚未确认，保留两个输入口径。" }],
      timeHandling: "user_provided_unverified"
    };
    const source = join(directory, "old-v1.json");
    const bytes = JSON.stringify(document);
    await writeFile(source, bytes);
    const io = capture();
    expect(await runCalculateCli(["--document", source, "--format", "json"], io.runtime)).toBe(0);
    expect(JSON.parse(io.output())).toEqual(document);
    expect(await readFile(source, "utf8")).toBe(bytes);
    expect(await readdir(directory)).toEqual(["old-v1.json"]);
    const text = capture();
    expect(await runCalculateCli(["--document", source], text.runtime)).toBe(0);
    expect(text.output()).toContain("2026 年度");
    expect(text.output()).toContain("2027 年度");
    expect(text.output()).toContain("出生分钟尚未确认，保留两个输入口径。");
  });

  it("reports a missing saved year before writing any replacement", async () => {
    const directory = await temporaryDirectory();
    const [document] = calculateDocuments(demo, options);
    const source = join(directory, "old-v1.json");
    const bytes = JSON.stringify(document);
    await writeFile(source, bytes);
    const io = capture();
    expect(await runCalculateCli(["--document", source, "--years", "2026", "--out", join(directory, "out")], io.runtime)).toBe(1);
    expect(io.error()).toContain("未保存 2026 年");
    expect(io.output()).toBe("");
    expect(await readFile(source, "utf8")).toBe(bytes);
    expect(await readdir(directory)).toEqual(["old-v1.json"]);
  });

  it("rejects a saved document whose chart candidates do not match", async () => {
    const directory = await temporaryDirectory();
    const [document] = calculateDocuments(demo, options);
    document.ziwei.candidateId = "CS-2000-999:different";
    const source = join(directory, "mixed.json");
    await writeFile(source, JSON.stringify(document));
    const io = capture();
    expect(await runCalculateCli(["--document", source], io.runtime)).toBe(1);
    expect(io.error()).toContain("候选 ID 不一致");
    expect(io.output()).toBe("");
  });

  it("preserves sibling candidates when re-exporting one saved document", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "input.json");
    const out = join(directory, "exports");
    const record = { ...demo, providedTime: { ...demo.providedTime, localTime: "23:30" } };
    await writeFile(source, JSON.stringify(record));
    expect(await runCalculateCli(["--input", source, "--out", out], capture().runtime)).toBe(0);
    const casePath = join(out, "CS-2000-001");
    const firstPath = join(casePath, "solar-current-day", "排盘.json");
    const siblingPath = join(casePath, "solar-next-day");
    await writeFile(join(siblingPath, "笔记.txt"), "合成手工笔记");
    const before = await Promise.all(["排盘.json", "排盘.txt", "笔记.txt"].map((name) => readFile(join(siblingPath, name), "utf8")));

    expect(await runCalculateCli(["--document", firstPath, "--out", out], capture().runtime)).toBe(0);
    expect(await Promise.all(["排盘.json", "排盘.txt", "笔记.txt"].map((name) => readFile(join(siblingPath, name), "utf8"))))
      .toEqual(before);

    await writeFile(source, JSON.stringify({ ...record, policy: { lateZi: "current_day" } }));
    expect(await runCalculateCli(["--input", source, "--out", out], capture().runtime)).toBe(0);
    expect(await readdir(siblingPath)).toEqual(["笔记.txt"]);
    expect(await readFile(join(siblingPath, "笔记.txt"), "utf8")).toBe(before[2]);
  });

  it("isolates different cases and replaces only generated files for the same case", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "out");
    const first = calculateDocuments({ ...demo, providedTime: { ...demo.providedTime, localTime: "23:30" } }, options);
    const second = calculateDocuments({ ...demo, caseId: "CS-2000-002", alias: "SYNTHETIC-SECOND" }, options);
    await writeDocuments(out, first);
    await writeDocuments(out, second);
    const secondPath = join(out, "CS-2000-002", "solar-current-day", "排盘.json");
    const secondBytes = await readFile(secondPath, "utf8");
    await writeFile(join(out, "CS-2000-001", "solar-next-day", "笔记.txt"), "合成手工笔记");
    const current = calculateDocuments(demo, options);
    await writeDocuments(out, current, undefined, true);
    await writeDocuments(out, current, undefined, true);
    expect(await readFile(secondPath, "utf8")).toBe(secondBytes);
    expect(await filesUnder(out)).toEqual([
      "CS-2000-001/solar-current-day/排盘.json", "CS-2000-001/solar-current-day/排盘.txt",
      "CS-2000-001/solar-next-day/笔记.txt", "CS-2000-002/solar-current-day/排盘.json", "CS-2000-002/solar-current-day/排盘.txt"
    ]);
    const saved = JSON.parse(await readFile(join(out, "CS-2000-001", "solar-current-day", "排盘.json"), "utf8"));
    expect(await readFile(join(out, "CS-2000-001", "solar-current-day", "排盘.txt"), "utf8"))
      .toBe(presentChartDocumentText(saved, "排盘.json", []).plainText);
  });
});
