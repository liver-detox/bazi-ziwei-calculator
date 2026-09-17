import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CALCULATOR_VERSION,
  ChartDocumentV1Schema,
  buildChartDocumentV1,
  chartDocumentFilename
} from "../src/core/workbench/chart-document.js";
import { CaseWorkbench } from "../src/core/workbench/case-workbench.js";
import { syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";
import { CURRENT_SOURCE_ID, calculateSourceId } from "../src/core/source-identity.js";

const roots: string[] = [];
const EXPORTED_AT = new Date("2026-08-13T06:30:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkbench(): Promise<CaseWorkbench> {
  const root = await mkdtemp(join(tmpdir(), "chart-document-v1-"));
  roots.push(root);
  return new CaseWorkbench(root, { now: () => EXPORTED_AT });
}

async function createStoredRevision(
  label: Parameters<typeof syntheticDemoRequest>[0],
  caseId: string,
  privateName?: string
): Promise<{
  workbench: CaseWorkbench;
  storedRevision: Record<string, unknown>;
  candidateIds: string[];
}> {
  const workbench = await makeWorkbench();
  const request = syntheticDemoRequest(label, caseId);
  if (privateName !== undefined) request.birthRecord.privateName = privateName;
  const created = await workbench.createCase(request);
  const timeEvidence = created.snapshot.timeEvidence as { candidates: Array<{ id: string }> };
  const candidateIds = timeEvidence.candidates.map(
    (candidate: { id: string }) => candidate.id
  );
  const storedRevision = await workbench.store.readRevision(
    caseId,
    created.revision.revisionId,
    { includePrivate: true }
  );
  return { workbench, storedRevision, candidateIds };
}

function build(
  storedRevision: Record<string, unknown>,
  candidateId: string,
  targetYear?: number
) {
  return buildChartDocumentV1({
    calculatorVersion: CALCULATOR_VERSION,
    exportedAt: EXPORTED_AT,
    storedRevision,
    requestedCandidateId: candidateId,
    ...(targetYear === undefined ? {} : { targetYear })
  });
}

describe("ChartDocument v1", () => {
  it("keeps source IDs reproducible across locations and sensitive to runtime source and lock changes only", async () => {
    const fixtures: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const root = await mkdtemp(join(tmpdir(), "synthetic-source-id-"));
      roots.push(root);
      fixtures.push(root);
      await mkdir(join(root, "release"));
      await mkdir(join(root, "src"));
      await mkdir(join(root, "data"));
      await mkdir(join(root, "dist"));
      await writeFile(join(root, "release/public-files.json"), JSON.stringify({ files: ["src/app.ts", "package-lock.json", "README.md"] }));
      await writeFile(join(root, "src/app.ts"), "export const synthetic = 1;\n");
      await writeFile(join(root, "package-lock.json"), "{\"synthetic\":1}\n");
      await writeFile(join(root, "README.md"), `Synthetic documentation ${index}`);
      await writeFile(join(root, "data/case.json"), `SYNTHETIC-EXCLUDED-DATA-${index}`);
      await writeFile(join(root, "dist/old-build.js"), `SYNTHETIC-EXCLUDED-BUILD-${index}`);
    }
    const first = calculateSourceId(fixtures[0]);
    expect(first).toMatch(/^src1-[a-f0-9]{16}$/u);
    expect(calculateSourceId(fixtures[0])).toBe(first);
    expect(calculateSourceId(fixtures[1])).toBe(first);
    await writeFile(join(fixtures[1], "src/app.ts"), "export const synthetic = 2;\n");
    expect(calculateSourceId(fixtures[1])).not.toBe(first);
    await writeFile(join(fixtures[1], "src/app.ts"), "export const synthetic = 1;\n");
    await writeFile(join(fixtures[1], "package-lock.json"), "{\"synthetic\":2}\n");
    expect(calculateSourceId(fixtures[1])).not.toBe(first);
    // The process identity is a startup constant; recalculating another tree cannot relabel it.
    expect(CURRENT_SOURCE_ID).toMatch(/^src1-[a-f0-9]{16}$/u);
  });

  it("creates and exports a birth-year luck start with an empty pre-luck annual segment", async () => {
    const workbench = await makeWorkbench();
    const request = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-971");
    request.birthRecord.calendar.date = "2000-03-04";
    request.birthRecord.gender = "男";
    request.birthRecord.providedTime.localTime = "12:34";
    const created = await workbench.createCase(request);
    const candidateId = (created.snapshot.timeEvidence as { candidates: Array<{ id: string }> }).candidates[0].id;
    const natal = await workbench.downloadChartDocument("CS-2000-971", created.revision.revisionId, { candidateId });
    expect(natal.document.bazi.chart.luck.startSolarDateTime).toBe("2000-07-14 12:34:00");
    expect(natal.document.bazi.chart.luck.daYun[0]).toMatchObject({ index: 0, startYear: 2000, endYear: 1999 });
    expect(natal.document.bazi.chart.annualFortunes).toEqual([]);

    const updated = await workbench.updateTargetYears("CS-2000-971", created.revision.revisionId, { targetYears: [2000, 2010] });
    const annual = await workbench.downloadChartDocument("CS-2000-971", updated.revision.revisionId, { candidateId, targetYear: 2000 });
    expect(annual.document.bazi.chart.annualFortunes.map(({ year, daYunIndex }) => [year, daYunIndex])).toEqual([[2000, 1], [2010, 2]]);
    expect(annual.document.bazi.detail.candidate.annualDetails.map(({ xiaoYun }) => xiaoYun.year)).toEqual([2000, 2010]);
  }, 20_000);

  it("exports one strictly validated ordinary document and prefers the entered name", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-911",
      "SYNTHETIC-NAME-JSON"
    );
    const candidateId = candidateIds[0];
    const document = build(storedRevision, candidateId);

    expect(document.exportSourceId).toBe(CURRENT_SOURCE_ID);
    const sourceBefore = structuredClone(storedRevision);
    const laterExport = buildChartDocumentV1({ calculatorVersion: CALCULATOR_VERSION, exportedAt: new Date("2026-08-20T00:00:00Z"), storedRevision, requestedCandidateId: candidateId });
    expect(laterExport.exportSourceId).toBe(document.exportSourceId);
    expect(laterExport.bazi).toEqual(document.bazi);
    expect(laterExport.ziwei).toEqual(document.ziwei);
    expect(storedRevision).toEqual(sourceBefore);
    const oldDocument = structuredClone(document);
    delete oldDocument.exportSourceId;
    expect(ChartDocumentV1Schema.parse(oldDocument).exportSourceId).toBeUndefined();

    expect(ChartDocumentV1Schema.parse(document)).toEqual(document);
    expect(document).toMatchObject({
      schemaVersion: 1,
      calculatorVersion: CALCULATOR_VERSION,
      subject: { nameOrAlias: "SYNTHETIC-NAME-JSON", gender: "女" },
      selection: { candidateId, hadAlternatives: false, rationale: null }
    });
    expect(document.bazi.chart.candidateId).toBe(candidateId);
    expect(document.bazi.detail.candidate.candidateId).toBe(candidateId);
    expect(document.ziwei.candidateId).toBe(candidateId);
    expect(document.evidence).toMatchObject({
      auditLevel: "A",
      workflowStatus: "review",
      allowedAnalysisModes: ["full_dual", "provisional_dual", "single_track", "data_diagnosis"],
      timeHandling: "user_provided_unverified"
    });
    expect(JSON.stringify(document)).not.toMatch(/birthplaceNote|providedTimeSourceNote|\/Users\//u);
  }, 20_000);

  it("falls back to the entered alias when no name was provided", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-912"
    );

    expect(build(storedRevision, candidateIds[0]).subject.nameOrAlias).toBe("DEMO-NORMAL");
  }, 20_000);

  it("requires a saved selection for late-Zi alternatives and exports only that candidate", async () => {
    const { workbench, storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-LATE-ZI",
      "CS-2001-911"
    );
    const [selectedCandidateId, otherCandidateId] = candidateIds;

    expect(() => build(storedRevision, selectedCandidateId)).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_SELECTION_REQUIRED" })
    );

    const decided = await workbench.recordDecision("CS-2001-911", "R001", {
      status: "selected",
      selectedCandidateId,
      rationale: "合成核验后选定这一候选。",
      workflowStatus: "verified",
      evidenceRefs: []
    });
    const selectedRevision = await workbench.store.readRevision(
      "CS-2001-911",
      decided.revision.revisionId,
      { includePrivate: true }
    );
    const document = build(selectedRevision, selectedCandidateId);

    expect(document.selection).toEqual({
      candidateId: selectedCandidateId,
      hadAlternatives: true,
      rationale: "合成核验后选定这一候选。"
    });
    expect(document.bazi.chart.candidateId).toBe(selectedCandidateId);
    expect(document.bazi.detail.candidate.candidateId).toBe(selectedCandidateId);
    expect(document.ziwei.candidateId).toBe(selectedCandidateId);
    const audit = selectedRevision.audit as {
      auditLevel: string;
      allowedAnalysisModes: string[];
      findings: Array<{ code: string; severity: string; summary: string }>;
    };
    expect(document.evidence).toMatchObject({
      auditLevel: audit.auditLevel,
      workflowStatus: "verified",
      allowedAnalysisModes: audit.allowedAnalysisModes,
      findings: audit.findings.map(({ code, severity, summary }) => ({ code, severity, summary }))
    });
    expect(document.evidence?.findings.some(({ code }) => code === "TIME_LATE_ZI_MATERIAL")).toBe(true);
    for (const finding of audit.findings.filter(({ severity }) => severity !== "info")) {
      expect(document.warnings).toContain(finding.summary);
    }
    expect(JSON.stringify({ bazi: document.bazi, ziwei: document.ziwei }))
      .not.toContain(otherCandidateId);
  }, 20_000);

  it("accepts only a target year present in all three selected result tracks", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-YEARS",
      "CS-2002-911"
    );

    expect(build(storedRevision, candidateIds[0], 2026).targetYear).toBe(2026);
    expect(() => build(storedRevision, candidateIds[0], 2027)).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_TARGET_YEAR_INVALID" })
    );
  }, 20_000);

  it("rejects a requested candidate different from the persisted selection", async () => {
    const { workbench, candidateIds } = await createStoredRevision(
      "DEMO-LATE-ZI",
      "CS-2001-912"
    );
    const [selectedCandidateId, otherCandidateId] = candidateIds;
    const decided = await workbench.recordDecision("CS-2001-912", "R001", {
      status: "selected",
      selectedCandidateId,
      rationale: "合成核验后选定这一候选。",
      workflowStatus: "verified",
      evidenceRefs: []
    });
    const selectedRevision = await workbench.store.readRevision(
      "CS-2001-912",
      decided.revision.revisionId,
      { includePrivate: true }
    );

    expect(() => build(selectedRevision, otherCandidateId)).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_CANDIDATE_MISMATCH" })
    );
  }, 20_000);

  it("rejects a modern source with no detailed Bazi result", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-913"
    );
    const missingDetail = structuredClone(storedRevision);
    delete missingDetail.baziDetail;

    expect(() => build(missingDetail, candidateIds[0])).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_BAZI_DETAIL_REQUIRED" })
    );
  }, 20_000);

  it("requires a current V2 input instead of mapping a historical V1 source", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-914"
    );
    const historical = structuredClone(storedRevision);
    historical.input = { schemaVersion: "1.0.0" };

    expect(() => build(historical, candidateIds[0])).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_CURRENT_INPUT_REQUIRED" })
    );
  }, 20_000);

  it("rejects an otherwise valid audit report that belongs to another case", async () => {
    const { storedRevision, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-916"
    );
    const crossCaseAudit = structuredClone(storedRevision);
    (crossCaseAudit.audit as { caseId: string }).caseId = "CS-2099-916";

    expect(() => build(crossCaseAudit, candidateIds[0])).toThrowError(
      expect.objectContaining({ code: "CHART_DOCUMENT_SOURCE_INVALID" })
    );
  }, 20_000);

  it("rejects a legitimately voided single-candidate revision", async () => {
    const { workbench, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-917"
    );
    const voided = await workbench.recordDecision("CS-2000-917", "R001", {
      status: "voided",
      rationale: "合成核验确认该修订已作废。",
      workflowStatus: "void",
      evidenceRefs: []
    });
    const voidedRevision = await workbench.store.readRevision(
      "CS-2000-917",
      voided.revision.revisionId,
      { includePrivate: true }
    );

    expect(() => build(voidedRevision, candidateIds[0])).toThrowError(
      expect.objectContaining({
        code: "CHART_DOCUMENT_SOURCE_INVALID",
        statusCode: 422
      })
    );
  }, 20_000);

  it("uses a safe minute-resolution UTC filename", () => {
    expect(chartDocumentFilename(EXPORTED_AT)).toBe("bazi-ziwei-chart-20260813-0630.json");
  });

  it("carries the package version in an actual document", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };
    const { workbench, candidateIds } = await createStoredRevision(
      "DEMO-NORMAL",
      "CS-2000-915"
    );

    const { document } = await workbench.downloadChartDocument("CS-2000-915", "R001", {
      candidateId: candidateIds[0]
    });

    expect(document.calculatorVersion).toBe(packageJson.version);
  }, 20_000);
});
