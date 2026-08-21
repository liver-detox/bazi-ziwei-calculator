import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  chartDocumentTextFilename,
  presentChartDocumentText
} from "../src/web/chart-document-text.js";
import { CaseWorkbench } from "../src/core/workbench/case-workbench.js";
import { syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";

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
    expect(view.plainText).toContain("### 目标流年与流月（仅在存在时）");
    expect(view.plainText).toContain("### 目标流年叠加（仅在存在时）");
    expect(document.bazi.chart.annualFortunes.map(({ year }) => year)).toContain(2030);
    expect(document.bazi.detail.candidate.annualDetails.map(({ year }) => year)).toContain(2030);
    expect(document.ziwei.yearlyFortunes.map(({ targetYear }) => targetYear)).toContain(2030);
    expect(view.plainText).not.toContain("流年 2030");

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

    target.decadal.palaceNames[0] = "合成命宫";
    target.decadal.palaceNames[1] = "合成财帛宫";
    target.decadal.starsByPalace[0] = [{
      name: "合成甲星", type: "主星", scope: "大限", brightness: null, transformation: null
    }];
    target.decadal.starsByPalace[1] = [{
      name: "合成乙星", type: "辅星", scope: "大限", brightness: null, transformation: null
    }];

    const text = presentChartDocumentText(document, filename).plainText;
    expect(text).toContain("合成命宫星曜：合成甲星");
    expect(text).toContain("合成财帛宫星曜：合成乙星");
    expect(text).not.toContain("第 0 宫星曜");
  });
});
