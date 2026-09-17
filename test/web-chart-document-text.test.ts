import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chartDocumentTextFilename,
  presentChartDocumentText
} from "../src/web/chart-document-text.js";
import { CaseWorkbench } from "../src/core/workbench/case-workbench.js";
import { ChartDocumentV1Schema } from "../src/core/workbench/chart-document.js";
import { ChartDocumentPrintout } from "../src/web/ChartDocumentPrintout.js";
import { FortunePage } from "../src/web/FortunePage.js";
import { BaziDetailPage } from "../src/web/BaziDetailPage.js";
import { ResultsShell } from "../src/web/ResultsShell.js";
import { ZiweiDetailPage } from "../src/web/ZiweiDetailPage.js";
import { createResultSelection, presentResults, selectTargetYear, type ResultSnapshotInput } from "../src/web/results-model.js";
import { baziDaYunDateIntervals, baziDaYunYearIntervals, resolveZiweiYearlyOverlay, ziweiHoroscopeTransformations, ziweiPalaceRelations } from "../src/shared/chart-display.js";
import {
  copyChartDocumentText,
  printChartDocumentText,
  saveChartDocumentTextDownload,
  type ChartDocumentBrowserSeam
} from "../src/web/export-download.js";
import { syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";
import { CURRENT_SOURCE_ID } from "#source-identity";
import { presentZiweiPalaces, ZIWEI_OVERLAY_UNAVAILABLE, ZIWEI_NATAL_UNAVAILABLE } from "../src/shared/ziwei-palace-presentation.js";
import { ziweiDecadalYearBoundary, ziweiDecadalBoundaryText } from "../src/shared/ziwei-decadal-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkbench(): Promise<CaseWorkbench> {
  const root = await mkdtemp(join(tmpdir(), "chart-document-text-"));
  roots.push(root);
  return new CaseWorkbench(root, { now: () => new Date("2026-08-19T08:30:00.000Z") });
}

describe("ChartDocument plain-text presentation", () => {
  it("groups all three layers by fixed natal palace across page, text and print without moving transformations to overlay stars", async () => {
    const workbench = await makeWorkbench();
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-997");
    request.birthRecord.calendar.date = "2000-03-04";
    request.birthRecord.gender = "男";
    request.birthRecord.providedTime.localTime = "12:34";
    request.targetYears = [2010, 2011];
    const created = await workbench.createCase(request);
    const snapshot = created.snapshot as unknown as ResultSnapshotInput;
    const candidateId = snapshot.timeEvidence.candidates[0].id;
    const { document, filename } = await workbench.downloadChartDocument(request.birthRecord.caseId, created.revision.revisionId, { candidateId, targetYear: 2011 });
    const original = structuredClone(document);
    const render = (doc: typeof document) => {
      const saved = structuredClone(snapshot);
      saved.charts.candidates[0].ziwei = doc.ziwei;
      const selection = { ...selectTargetYear(createResultSelection(saved), saved, 2011), ziweiMode: "yearly" as const };
      const text = presentChartDocumentText(doc, filename).plainText;
      return { text, page: renderToStaticMarkup(createElement(ZiweiDetailPage, { snapshot: saved, selection, onSelectionChange: () => {} })), print: renderToStaticMarkup(createElement(ChartDocumentPrintout, { text })) };
    };
    const projected = presentZiweiPalaces(document.ziwei, 2011);
    expect(projected.status).toBe("available");
    expect(projected.unresolved).toEqual([]);
    const output = render(document);
    for (const palace of projected.palaces) {
      const pagePalace = output.page.split(`data-palace-index="${palace.index}"`)[1].split("</article>")[0];
      const textPalace = output.text.split(`### ${palace.name} · ${palace.ganZhi}\n`)[1].split("\n### ")[0];
      const printPalace = output.print.split(`<h3>${palace.name} · ${palace.ganZhi}</h3>`)[1].split("<h3>")[0];
      for (const block of [pagePalace, textPalace, printPalace]) {
        expect(block.indexOf(palace.layers[0].title)).toBeLessThan(block.indexOf(palace.layers[1].title));
        expect(block.indexOf(palace.layers[1].title)).toBeLessThan(block.indexOf(palace.layers[2].title));
        for (const layer of palace.layers) for (const field of layer.fields) expect(block).toContain(field.value);
      }
    }
    expect(output.text).toContain("年度代表盘日期：2011-07-01");
    for (const result of Object.values(output)) {
      expect(result).toContain("命宫对应本命父母宫 · 酉");
      expect(result).toContain("寅宫 · 对宫 申 · 三合 午、戌");
      expect(result).not.toContain("固定索引");
      expect(result).not.toContain("命宫对应本命索引");
    }
    expect(output.text).toContain("紫微交限日期：2011-02-03");
    expect(presentZiweiPalaces(document.ziwei, 2010).boundary.join(" ")).toContain("不跨大限");
    expect(presentZiweiPalaces(document.ziwei).palaces.every((palace) => palace.layers.length === 1)).toBe(true);
    expect(document).toEqual(original);

    const located = structuredClone(document);
    const fortune = located.ziwei.yearlyFortunes.find(({ targetYear }) => targetYear === 2011)!;
    const starName = fortune.decadal.transformations[0];
    const natalIndex = located.ziwei.palaces.findIndex((palace) => [...palace.majorStars, ...palace.minorStars].some((star) => star.name === starName));
    const otherIndex = (natalIndex + 1) % 12;
    expect(natalIndex).not.toBe(fortune.decadal.index);
    expect(otherIndex).not.toBe(fortune.decadal.index);
    fortune.decadal.starsByPalace[otherIndex] = [{ name: starName, type: "soft", scope: "decadal", brightness: "合成唯一庙旺标记", transformation: null }];
    const reading = presentZiweiPalaces(located.ziwei, 2011);
    expect(reading.palaces[natalIndex].layers[1].fields[1].value).toContain(`禄：${starName}`);
    expect(reading.palaces[otherIndex].layers[1].fields[1].value).not.toContain(`禄：${starName}`);
    for (const result of Object.values(render(located))) expect(result.match(/合成唯一庙旺标记/gu)).toHaveLength(1);

    for (const mode of ["missing-stars", "null-stars", "duplicate-star", "absent-star", "conflicting-birth", "missing-birth"] as const) {
      const dirty = structuredClone(document);
      if (mode === "missing-stars") delete (dirty.ziwei.palaces[otherIndex] as Partial<typeof dirty.ziwei.palaces[0]>).majorStars;
      if (mode === "null-stars") (dirty.ziwei.palaces[otherIndex] as unknown as { majorStars: null }).majorStars = null;
      if (mode === "duplicate-star") dirty.ziwei.palaces[otherIndex].minorStars.push({ name: starName, type: "soft", scope: "origin", brightness: null, transformation: null });
      if (mode === "absent-star") dirty.ziwei.yearlyFortunes[1].decadal.transformations[0] = "合成未定位星";
      if (mode === "conflicting-birth") dirty.ziwei.transformations[0].palaceIndex = (dirty.ziwei.transformations[0].palaceIndex + 1) % 12;
      if (mode === "missing-birth") delete (dirty.ziwei as Partial<typeof dirty.ziwei>).transformations;
      const before = structuredClone(dirty);
      const results = render(dirty);
      for (const result of Object.values(results)) expect(result).toContain("未定位四化说明");
      if (mode === "missing-stars" || mode === "null-stars") for (const result of Object.values(results)) expect(result).toContain("未提供（本字段缺失）");
      expect(dirty).toEqual(before);
    }
    for (const mode of ["duplicate-year", "missing-yearly", "missing-names", "missing-slots", "missing-transformations", "wrong-date", "wrong-index", "duplicate-ming"] as const) {
      const dirty = structuredClone(document);
      const fortune = dirty.ziwei.yearlyFortunes[1];
      if (mode === "duplicate-year") dirty.ziwei.yearlyFortunes.push(structuredClone(fortune));
      if (mode === "missing-yearly") delete (dirty.ziwei as Partial<typeof dirty.ziwei>).yearlyFortunes;
      if (mode === "missing-names") delete (fortune.decadal as Partial<typeof fortune.decadal>).palaceNames;
      if (mode === "missing-slots") delete (fortune.yearly as Partial<typeof fortune.yearly>).starsByPalace;
      if (mode === "missing-transformations") delete (fortune.yearly as Partial<typeof fortune.yearly>).transformations;
      if (mode === "wrong-date") fortune.targetDate = "2011-02-02";
      if (mode === "wrong-index") fortune.yearly.index = (fortune.yearly.index + 1) % 12;
      if (mode === "duplicate-ming") fortune.decadal.palaceNames[(fortune.decadal.index + 1) % 12] = "命宫";
      const results = render(dirty);
      for (const result of Object.values(results)) expect(result).toContain(ZIWEI_OVERLAY_UNAVAILABLE);
      expect(results.page).not.toContain('data-reading-layer="yearly"');
      expect(results.text).not.toContain("#### 流年 ·");
    }
    for (const targetYear of [undefined, 2011]) {
      const dirty = structuredClone(document);
      dirty.targetYear = targetYear;
      [dirty.ziwei.palaces[0], dirty.ziwei.palaces[1]] = [dirty.ziwei.palaces[1], dirty.ziwei.palaces[0]];
      const results = render(dirty);
      for (const result of Object.values(results)) {
        expect(result).toContain(ZIWEI_NATAL_UNAVAILABLE);
        expect(result).not.toContain("当前仅显示本命");
        expect(result).not.toContain("仅保留本命");
      }
    }
  }, 20_000);

  it("shares a Spring Festival switch with the page and print while keeping export and presenter identities separate", async () => {
    const workbench = await makeWorkbench();
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-994");
    request.birthRecord.calendar.date = "2000-03-04";
    request.birthRecord.gender = "男";
    request.birthRecord.providedTime.localTime = "12:34";
    request.targetYears = [2011];
    const created = await workbench.createCase(request);
    const snapshot = created.snapshot as unknown as ResultSnapshotInput;
    const candidateId = snapshot.timeEvidence.candidates[0].id;
    const { document, filename } = await workbench.downloadChartDocument(request.birthRecord.caseId, created.revision.revisionId, { candidateId, targetYear: 2011 });
    const original = structuredClone(document);
    const boundary = ziweiDecadalYearBoundary(document.ziwei, 2011);
    expect(boundary).toMatchObject({ status: "changed", date: "2011-02-03", eve: "2011-02-02", before: { palaceIndex: 6, natalPalace: "命宫", ganZhi: "甲申" }, after: { palaceIndex: 7, natalPalace: "父母", ganZhi: "乙酉" } });
    const text = presentChartDocumentText(document, filename).plainText;
    const selection = { ...createResultSelection(snapshot), ziweiMode: "yearly" as const };
    const page = renderToStaticMarkup(createElement(ZiweiDetailPage, { snapshot, selection, onSelectionChange: () => {} }));
    const printed = renderToStaticMarkup(createElement(ChartDocumentPrintout, { text }));
    for (const output of [text, page, printed]) {
      for (const line of ziweiDecadalBoundaryText(boundary)) expect(output).toContain(line);
    }
    expect(text).toContain(`JSON 导出源码标识：${CURRENT_SOURCE_ID}`);
    expect(text).toContain(`本次文本呈现源码标识：${CURRENT_SOURCE_ID}`);
    const olderExport = structuredClone(document);
    olderExport.exportSourceId = "src1-0000000000000000";
    const reRendered = presentChartDocumentText(ChartDocumentV1Schema.parse(olderExport), filename).plainText;
    expect(reRendered).toContain("JSON 导出源码标识：src1-0000000000000000");
    expect(reRendered).toContain(`本次文本呈现源码标识：${CURRENT_SOURCE_ID}`);
    delete olderExport.exportSourceId;
    delete olderExport.evidence;
    const legacy = ChartDocumentV1Schema.parse(olderExport);
    const legacyText = presentChartDocumentText(legacy, filename).plainText;
    expect(legacyText).toContain("JSON 导出源码标识：未知（旧版 V1 未记录）");
    expect(legacyText).toContain("紫微交限日期：2011-02-03");
    expect(legacy.bazi).toEqual(document.bazi);
    expect(legacy.ziwei).toEqual(document.ziwei);
    expect(document).toEqual(original);

    const corruptions: Array<(chart: typeof document.ziwei) => void> = [
      (chart) => { chart.input.engineInputDate = "未提供"; },
      (chart) => { chart.input.engineInputDate = "2000-02-30"; chart.solarDate = "2000-02-30"; },
      (chart) => { chart.configuration.ageDivide = "birthday" as "normal"; },
      (chart) => { chart.configuration.horoscopeDivide = "exact" as "normal"; },
      (chart) => { delete (chart as { configuration?: unknown }).configuration; },
      (chart) => { chart.palaces[0].decadal.endAge -= 1; },
      (chart) => { chart.palaces[0].decadal = { ...chart.palaces[1].decadal }; },
      (chart) => { chart.palaces.forEach(({ decadal }) => { decadal.startAge += 1; decadal.endAge += 1; }); },
      (chart) => { chart.yearlyFortunes[0].decadal.index = 3; },
      (chart) => { chart.yearlyFortunes[0].targetDate = "2011-02-03"; },
      (chart) => { chart.yearlyFortunes = []; }
    ];
    for (const corrupt of corruptions) {
      const invalid = structuredClone(document.ziwei);
      corrupt(invalid);
      const unavailable = ziweiDecadalYearBoundary(invalid, 2011);
      expect(unavailable.status).toBe("unavailable");
      expect(ziweiDecadalBoundaryText(unavailable).join("\n")).toContain("紫微交限日期不可用");
    }
    expect(ziweiDecadalYearBoundary(document.ziwei, null).status).toBe("unselected");
    expect(ziweiDecadalYearBoundary(document.ziwei, 2100).status).toBe("unavailable");
  }, 20_000);

  it("preserves the configured engine year boundaries and unresolved leap-month alternatives", async () => {
    const workbench = await makeWorkbench();
    // Synthetic engine regressions; these are not independent historical calendar evidence.
    for (const [suffix, date, ziweiYear] of [["1", "2024-02-05", "癸卯"], ["2", "2024-02-11", "甲辰"]] as const) {
      const request = syntheticDemoRequest("DEMO-NORMAL", `CS-2024-98${suffix}`);
      request.birthRecord.calendar.date = date;
      const created = await workbench.createCase(request);
      const snapshot = created.snapshot as unknown as ResultSnapshotInput;
      const candidateId = snapshot.timeEvidence.candidates[0].id;
      const { document, filename } = await workbench.downloadChartDocument(request.birthRecord.caseId, created.revision.revisionId, { candidateId });
      expect(document.bazi.chart.pillars.year.ganZhi).toBe("甲辰");
      expect(document.ziwei.chineseDate.startsWith(ziweiYear)).toBe(true);
      expect(document.bazi.chart.input.calculationLocalDateTime).toBe(`${date}T12:00`);
      const text = presentChartDocumentText(document, filename).plainText;
      expect(text).toContain("八字以立春换年、十二节分月；紫微以农历正月初一换年");
      expect(text).toContain("7 月 1 日的代表盘");
      expect(baziDaYunDateIntervals(document.bazi.chart)).not.toBeNull();
    }
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2023-983");
    request.birthRecord.calendar = { type: "lunar", date: "2023-02-01", leapMonth: "unknown" };
    const created = await workbench.createCase(request);
    const snapshot = created.snapshot as unknown as ResultSnapshotInput;
    expect(snapshot.charts.candidates.map(({ bazi }) => [bazi.calendar.isLeapMonth, bazi.calendar.solarDate])).toEqual([
      [false, "2023-02-20"], [true, "2023-03-22"]
    ]);
    const candidateId = snapshot.timeEvidence.candidates[1].id;
    await expect(workbench.downloadChartDocument(request.birthRecord.caseId, created.revision.revisionId, { candidateId })).rejects.toMatchObject({ code: "CHART_DOCUMENT_SELECTION_REQUIRED" });
    const selected = await workbench.recordDecision(request.birthRecord.caseId, created.revision.revisionId, {
      status: "selected", selectedCandidateId: candidateId, rationale: "合成测试选择闰月候选，不作为出生资料证实。", workflowStatus: "review", evidenceRefs: []
    });
    const { document, filename } = await workbench.downloadChartDocument(request.birthRecord.caseId, selected.revision.revisionId, { candidateId });
    expect(document.selection.hadAlternatives).toBe(true);
    expect(document.bazi.chart.calendar.isLeapMonth).toBe(true);
    expect(document.evidence?.findings.some(({ code }) => code === "TIME_LEAP_MONTH_UNRESOLVED")).toBe(true);
    expect(document.evidence?.allowedAnalysisModes).toEqual(["data_diagnosis"]);
    expect(presentChartDocumentText(document, filename).plainText).toContain("TIME_LEAP_MONTH_UNRESOLVED");
    expect(baziDaYunDateIntervals(document.bazi.chart)).not.toBeNull();
  }, 20_000);

  it("separates annual indexing from the exact switch instant in the page and shared text", async () => {
    const workbench = await makeWorkbench();
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-973");
    request.birthRecord.calendar.date = "2000-03-04";
    request.birthRecord.gender = "男";
    request.birthRecord.providedTime.localTime = "12:34";
    request.targetYears = [2000, 2010];
    const created = await workbench.createCase(request);
    const snapshot = created.snapshot as unknown as ResultSnapshotInput;
    const candidateId = snapshot.timeEvidence.candidates[0].id;
    const { document, filename } = await workbench.downloadChartDocument(request.birthRecord.caseId, created.revision.revisionId, { candidateId, targetYear: 2010 });
    const childhood = presentZiweiPalaces(document.ziwei, 2000);
    expect(childhood.status).toBe("available");
    expect(childhood.palaces.every((palace) => palace.layers[1].title.startsWith("童限 ·"))).toBe(true);
    expect(childhood.palaces.every((palace) => palace.layers[1].fields[1].label === "童限四化")).toBe(true);
    expect(document.bazi.chart.annualFortunes.find(({ year }) => year === 2010)?.daYunIndex).toBe(2);
    const intervals = baziDaYunDateIntervals(document.bazi.chart)!;
    for (const [date, expectedIndex] of [
      ["2000-07-14 12:33:59", 0], ["2000-07-14 12:34:00", 1],
      ["2010-07-14 12:33:59", 1], ["2010-07-14 12:34:00", 2], ["2010-07-14 12:34:01", 2]
    ] as const) {
      expect(intervals.filter(({ start, end }) => start <= date && date < end).map(({ daYunIndex }) => daYunIndex)).toEqual([expectedIndex]);
    }
    expect(baziDaYunYearIntervals(document.bazi.chart, 2010)!.map(({ start, end, daYunIndex }) => ({ start, end, daYunIndex }))).toEqual([
      { start: "2010-01-01 00:00:00", end: "2010-07-14 12:34:00", daYunIndex: 1 },
      { start: "2010-07-14 12:34:00", end: "2011-01-01 00:00:00", daYunIndex: 2 }
    ]);
    const text = presentChartDocumentText(document, filename).plainText;
    const selection = selectTargetYear(createResultSelection(snapshot), snapshot, 2010);
    const page = renderToStaticMarkup(createElement(FortunePage, { snapshot, selection, onSelectionChange: () => {}, isNarrow: false }));
    const printed = renderToStaticMarkup(createElement(ChartDocumentPrintout, { text }));
    for (const output of [text, page, printed]) {
      expect(output).toContain("2010-07-14 12:34:00");
      expect(output).toContain("年表索引不代表全年日期归属");
      expect(output).toContain("起运法 1");
      expect(output).toContain("所选公历年内的大运分段");
    }
    expect(page).toContain("年表索引：大运第 2 段");
    expect(page).not.toContain("所属大运");
    expect(page).not.toContain("2000–1999");
    const earlySelection = { ...selectTargetYear(selection, snapshot, 2000), activePage: "overview" as const };
    const earlyPages = [
      renderToStaticMarkup(createElement(BaziDetailPage, { presentation: presentResults(snapshot, earlySelection) })),
      renderToStaticMarkup(createElement(FortunePage, { snapshot, selection: earlySelection, onSelectionChange: () => {}, isNarrow: false })),
      renderToStaticMarkup(createElement(ResultsShell, {
        snapshot, selection: earlySelection, caseName: "SYNTHETIC-BIRTH-YEAR", copyForAiState: "ready", isNarrow: false,
        onSelectionChange: () => {}, onOpenCaseDialog: () => {}, onModifyInput: () => {}, onOpenVerification: () => {}, onCopyForAi: () => {}
      }))
    ];
    for (const earlyPage of earlyPages) {
      expect(earlyPage).toContain("出生当年起运");
      expect(earlyPage).not.toMatch(/2000–1999|1–0/u);
    }
    expect(text).toContain("出生后 0 年 4 月 10 天 0 小时起运");
    expect(text).not.toMatch(/起运后年|half_open|minute_truncate/u);
    expect(text).toContain("含开始，不含结束（左闭右开）");
    expect(text).toContain("截去秒，不四舍五入");
    expect(text).toContain("时间精度：提供到分钟（用户声明）");
    for (const invalidStart of ["未提供", "2000-07-14", "1999-07-14 12:34:00", "2000-02-30 12:34:00"]) {
      const invalid = structuredClone(document);
      invalid.bazi.chart.luck.startSolarDateTime = invalidStart;
      // Legacy contracts permit these strings, so the presentation must handle them.
      expect(ChartDocumentV1Schema.safeParse(invalid).success).toBe(true);
      expect(baziDaYunDateIntervals(invalid.bazi.chart)).toBeNull();
      expect(presentChartDocumentText(invalid, filename).plainText).toContain("大运日期分段不可用");
      const invalidSnapshot = structuredClone(snapshot);
      invalidSnapshot.charts.candidates[0].bazi.luck.startSolarDateTime = invalidStart;
      expect(renderToStaticMarkup(createElement(FortunePage, { snapshot: invalidSnapshot, selection, onSelectionChange: () => {}, isNarrow: false }))).toContain("大运日期分段不可用");
    }
    // No new stored field is needed: an older V1 projects the same saved calculation.
    const legacy = structuredClone(document);
    delete legacy.evidence;
    expect(presentChartDocumentText(ChartDocumentV1Schema.parse(legacy), filename).plainText).toContain("2010-07-14 12:34:00");
  }, 20_000);

  it.each([
    ["minute", "civil_clock_provided", "birth_certificate", "A", null],
    ["approximate", "apparent_solar_provided", "external_true_solar_tool", "C", "PRECISION_APPROXIMATE_UNRESOLVED"],
    ["branch", "civil_clock_provided", "family_memory", "C", "PRECISION_BRANCH_UNRESOLVED"]
  ] as const)("carries %s evidence through JSON, AI copy, TXT and print without private notes", async (
    precision, basis, sourceType, auditLevel, findingCode
  ) => {
    const workbench = await makeWorkbench();
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-931");
    request.birthRecord.privateName = "SYNTHETIC-EXPORTED-NAME";
    request.birthRecord.providedTime = {
      ...request.birthRecord.providedTime, precision, basis, sourceType,
      sourceNote: "SYNTHETIC-PRIVATE-SOURCE-NOTE"
    };
    request.privateContext = { birthplaceNote: "SYNTHETIC-PRIVATE-PLACE-NOTE" };
    const created = await workbench.createCase(request);
    const candidateId = (created.snapshot.timeEvidence as { candidates: Array<{ id: string }> }).candidates[0].id;
    const { document: exported, filename } = await workbench.downloadChartDocument(
      request.birthRecord.caseId, created.revision.revisionId, { candidateId }
    );
    const json = JSON.stringify(exported);
    const document = ChartDocumentV1Schema.parse(JSON.parse(json));
    expect(document).toEqual(exported);
    expect(document.evidence?.auditLevel).toBe(auditLevel);
    expect(document.evidence?.timeHandling).toBe("user_provided_unverified");
    expect(document.birthInput.providedTime.localTime).toBe("12:00");
    expect(document.bazi.chart.input.calculationLocalDateTime).toBe("2000-01-15T12:00");
    const audit = created.snapshot.audit as {
      allowedAnalysisModes: string[];
      findings: Array<{ code: string; severity: string; summary: string }>;
    };
    expect(document.evidence?.allowedAnalysisModes).toEqual(audit.allowedAnalysisModes);
    expect(document.evidence?.findings).toEqual(audit.findings.map(({ code, severity, summary }) => ({ code, severity, summary })));
    if (findingCode !== null) {
      expect(document.evidence?.allowedAnalysisModes).toEqual(["single_track", "data_diagnosis"]);
      expect(document.evidence?.findings).toContainEqual(expect.objectContaining({ code: findingCode }));
      const summary = audit.findings.find(({ code }) => code === findingCode)?.summary;
      expect(summary).toBeDefined();
      expect(document.warnings).toContain(summary);
    }

    const view = presentChartDocumentText(document, filename);
    const introduction = view.plainText.split("## 文档信息")[0];
    expect(introduction).toContain(`当前修订计算审计等级：${auditLevel}`);
    expect(introduction).toContain("不证明出生资料真实，也不代表预测高置信");
    expect(introduction).toContain("未独立核验");
    expect(introduction).toContain("本次计算未按地点、时区、夏令时（DST）或真太阳时自动校正");
    expect(introduction).toContain("不要自行重复校正");
    expect(introduction).toContain(basis === "apparent_solar_provided" ? "用户声明已校正为真太阳时" : "用户提供的当地钟表时间");
    if (findingCode !== null) {
      expect(introduction).toContain(findingCode);
      expect(introduction).toContain("单轨分析（仅限证据支持的轨道）");
      expect(introduction).toContain("资料诊断");
      expect(introduction).not.toMatch(/full_dual|provisional_dual/u);
    }

    const blobs: Blob[] = [];
    const browser: ChartDocumentBrowserSeam = {
      createObjectURL: (blob) => { blobs.push(blob); return "blob:synthetic-evidence"; },
      revokeObjectURL: vi.fn(), clickDownload: vi.fn(),
      writeClipboardText: vi.fn(async () => {}),
      supportsShare: () => false, canShare: () => false, share: vi.fn(async () => {}),
      print: vi.fn(), getPageTitle: () => "合成验收", setPageTitle: vi.fn()
    };
    await copyChartDocumentText({ view, browser });
    expect(browser.writeClipboardText).toHaveBeenCalledWith(view.plainText);
    saveChartDocumentTextDownload({ view, browser });
    expect(await blobs[0].text()).toBe(view.plainText);
    let printText = "";
    await printChartDocumentText({ view, browser, reveal: (text) => { printText = text; }, conceal: () => {} });
    expect(printText).toBe(view.plainText);
    const html = renderToStaticMarkup(createElement(ChartDocumentPrintout, { text: printText }));
    expect(html).toContain(`当前修订计算审计等级：${auditLevel}`);
    expect(html).toContain("未独立核验");
    if (findingCode !== null) expect(html).toContain(findingCode);
    for (const output of [json, view.plainText, html]) {
      expect(output).toContain("SYNTHETIC-EXPORTED-NAME");
      expect(output).not.toMatch(/SYNTHETIC-PRIVATE|privateContext|birthplaceNote|sourceNote|evidenceRefs|\/Users\//u);
    }

    // The old V1 shape remains valid; deleting evidence must not turn uncertainty into clearance.
    const legacy = structuredClone(document);
    delete legacy.evidence;
    legacy.warnings = [];
    expect(ChartDocumentV1Schema.parse(legacy)).toEqual(legacy);
    const legacyText = presentChartDocumentText(legacy, filename).plainText;
    expect(legacyText).toContain("计算审计等级：未知");
    expect(legacyText).toContain("允许分析范围：未知");
    expect(legacyText).toContain("时间处理：未知");
    expect(legacyText).toContain("警告为空不代表无风险");
    expect(legacyText).not.toContain("警告：未提供");
  }, 20_000);

  it("projects a synthetic selected chart into deterministic, safe, ordered text", async () => {
    const workbench = await makeWorkbench();
    const created = await workbench.createCase(syntheticDemoRequest("DEMO-YEARS", "CS-2002-930"));
    const candidateId = (created.snapshot.timeEvidence as { candidates: Array<{ id: string }> })
      .candidates[0].id;
    const { document, filename } = await workbench.downloadChartDocument(
      "CS-2002-930",
      created.revision.revisionId,
      { candidateId, targetYear: 2026 }
    );
    const view = presentChartDocumentText(document, filename);

    expect(view.filename).toBe(filename.replace(/\.json$/u, ".txt"));
    expect(view.contentType).toBe("text/plain; charset=utf-8");
    expect(view.plainText).toContain("# 八字与紫微斗数双轨排盘");
    expect(view.plainText.indexOf("## 输入资料"))
      .toBeLessThan(view.plainText.indexOf("## 八字"));
    expect(view.plainText.indexOf("## 八字"))
      .toBeLessThan(view.plainText.indexOf("## 紫微斗数"));
    expect(view.plainText).toContain("目标流年：2026");
    expect(view.plainText.indexOf("## 证据限制与分析范围"))
      .toBeLessThan(view.plainText.indexOf("## 输入资料"));
    expect(view.plainText).toContain("### 目标流年与流月（仅在存在时）");
    expect(view.plainText).toContain("### 十二宫逐宫合并");
    expect(document.bazi.chart.annualFortunes.map(({ year }) => year)).toContain(2030);
    expect(document.bazi.detail.candidate.annualDetails.map(({ year }) => year)).toContain(2030);
    expect(document.ziwei.yearlyFortunes.map(({ targetYear }) => targetYear)).toContain(2030);
    expect(view.plainText).not.toContain("流年 2030");
    expect(view.plainText).toContain("完整 JSON 已算目标年份：2026、2030");
    expect(view.plainText).toContain("仅展开目标年 2026");
    expect(view.plainText).toContain("紫微以农历正月初一换年");
    expect(view.plainText).toContain("7 月 1 日的代表盘");
    const noSelection = structuredClone(document);
    delete noSelection.targetYear;
    const natalOnlyText = presentChartDocumentText(noSelection, filename).plainText;
    expect(natalOnlyText).toContain("未选择目标年，不展开流年、流月及紫微年度叠加");
    expect(natalOnlyText).toContain("完整 JSON 已算目标年份：2026、2030");
    expect(natalOnlyText).not.toMatch(/#### 流年 (2026|2030)/u);

    const overlay = resolveZiweiYearlyOverlay(document.ziwei, 2026);
    expect(overlay).not.toBeNull();
    const rows = ziweiPalaceRelations(document.ziwei, overlay);
    expect(rows[0]).toMatchObject({ index: 0, earthlyBranch: "寅", oppositeIndex: 6, trineIndexes: [4, 8] });
    expect([rows[4].earthlyBranch, rows[8].earthlyBranch, rows[6].earthlyBranch]).toEqual(["午", "戌", "申"]);
    expect(view.plainText).toContain(`| 寅 | ${rows[0].natal} | ${overlay!.decadal.palaceNames[0]} | ${overlay!.yearly.palaceNames[0]} | 申 | 午、戌 |`);
    const snapshot = created.snapshot as unknown as ResultSnapshotInput;
    const selection = { ...selectTargetYear(createResultSelection(snapshot), snapshot, 2026), ziweiMode: "yearly" as const };
    const ziweiPage = renderToStaticMarkup(createElement(ZiweiDetailPage, { snapshot, selection, onSelectionChange: () => {} }));
    for (const layer of [overlay!.decadal, overlay!.yearly]) {
      const transformations = ziweiHoroscopeTransformations(document.ziwei, layer);
      expect(transformations.map(({ transformation }) => transformation)).toEqual(["禄", "权", "科", "忌"]);
      for (const transformation of transformations) {
        expect(transformation.natalPalace).not.toBeNull();
        const description = `${transformation.transformation}：${transformation.starName}`;
        expect(view.plainText).toContain(description);
        expect(ziweiPage).toContain(description);
      }
    }

    expect(document.ziwei.palaces.some(({ majorStars }) => majorStars.length === 0)).toBe(true);
    expect(view.plainText).toContain("主星：无十四主星");
    expect(view.plainText).toContain("辅星：无本字段所列辅星");
    expect(view.plainText).toContain("无本层附加星曜（本字段所列范围）");
    expect(view.plainText).toContain("不表示整宫无星");
    expect(view.plainText).not.toMatch(/主星：未提供|辅星：未提供/u);
    const missingField = structuredClone(document);
    delete (missingField.ziwei.palaces[0] as Partial<typeof missingField.ziwei.palaces[0]>).majorStars;
    expect(presentChartDocumentText(missingField, filename).plainText).toContain("主星：未提供（本字段缺失）");

    for (const pillar of document.bazi.chart.fourPillars) {
      expect(view.plainText).toContain(pillar);
    }
    expect(document.ziwei.palaces).toHaveLength(12);
    for (const palace of document.ziwei.palaces) {
      expect(view.plainText).toContain(`### ${palace.name}`);
      for (const star of [...palace.majorStars, ...palace.minorStars]) {
        expect(view.plainText).toContain(star.name);
      }
    }
    const annualDetail = document.bazi.detail.candidate.annualDetails
      .find((item) => item.year === document.targetYear);
    expect(annualDetail).toBeDefined();
    if (annualDetail === undefined) throw new Error("synthetic target-year detail missing");
    expect(annualDetail.liuYue).toHaveLength(12);
    for (const month of annualDetail.liuYue) {
      expect(view.plainText).toContain(month.monthName);
      expect(view.plainText).toContain(month.ganZhi);
    }

    expect(presentChartDocumentText(document, filename)).toEqual(view);
    expect(view.plainText).not.toContain(document.bazi.detail.candidate.sourceBaziCandidateFingerprint);
    expect(view.plainText).not.toMatch(/privateContext|birthplaceNote|providedTimeSourceNote|\/Users\//u);
    expect(view.plainText).not.toMatch(/旺衰|格局|用神|吉凶建议/u);

    const attacked = structuredClone(document);
    attacked.subject.nameOrAlias = "合\u202e成\u2066名\u200b可\ufeff见\n# 伪造标题\t尾";
    attacked.selection.rationale = "合成理由\r\n## 伪造章节";
    attacked.warnings = ["合成警告\u001b\u0085\n- 伪造列表"];
    const attackedText = presentChartDocumentText(attacked, filename).plainText;
    expect(attackedText).not.toMatch(/\n# 伪造标题|\n## 伪造章节|\n- 伪造列表/u);
    expect(attackedText).not.toContain("\u202e");
    expect(attackedText).not.toContain("\u2066");
    expect(attackedText).not.toContain("\u200b");
    expect(attackedText).not.toContain("\ufeff");
    expect(attackedText).toContain("合成名可见 # 伪造标题 尾");
  }, 20_000);

  it("derives a text filename from one safe chart-document JSON filename", () => {
    expect(chartDocumentTextFilename("bazi-ziwei-chart-20260819-0830.json"))
      .toBe("bazi-ziwei-chart-20260819-0830.txt");

    for (const filename of [
      "../bazi-ziwei-chart-20260819-0830.json",
      "other-chart-20260819-0830.json",
      "bazi-ziwei-chart-20260819-0830.txt",
      "bazi-ziwei-chart-20260819-0830.json\n"
    ]) {
      expect(() => chartDocumentTextFilename(filename)).toThrow();
    }
  });

  it("labels fortune stars with their indexed palace names", async () => {
    const workbench = await makeWorkbench();
    const created = await workbench.createCase(syntheticDemoRequest("DEMO-YEARS", "CS-2002-930"));
    const candidateId = (created.snapshot.timeEvidence as { candidates: Array<{ id: string }> })
      .candidates[0].id;
    const { document, filename } = await workbench.downloadChartDocument(
      "CS-2002-930",
      created.revision.revisionId,
      { candidateId, targetYear: 2026 }
    );
    const target = document.ziwei.yearlyFortunes.find(({ targetYear }) => targetYear === 2026);
    expect(target).toBeDefined();
    if (target === undefined) throw new Error("synthetic target-year fortune missing");

    const [first, second] = target.decadal.palaceNames.map((_, index) => index).filter((index) => index !== target.decadal.index);
    target.decadal.palaceNames[first] = "合成甲宫";
    target.decadal.palaceNames[second] = "合成乙宫";
    target.decadal.starsByPalace[first] = [{
      name: "合成甲星", type: "主星", scope: "大限", brightness: null, transformation: null
    }];
    target.decadal.starsByPalace[second] = [{
      name: "合成乙星", type: "辅星", scope: "大限", brightness: null, transformation: null
    }];

    const text = presentChartDocumentText(document, filename).plainText;
    expect(text).toContain("#### 大限 · 合成甲宫\n- 附加星曜：合成甲星");
    expect(text).toContain("#### 大限 · 合成乙宫\n- 附加星曜：合成乙星");
    expect(text).not.toContain("第 0 宫星曜");
  });
});
