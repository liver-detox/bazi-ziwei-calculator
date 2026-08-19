import { z } from "zod";

import { AuditReportV2Schema } from "../audit/index.js";
import {
  BaziDetailBaseChartSetSourceSchema,
  BaziDetailCandidateV1Schema,
  BaziDetailV1Schema,
  StrictCompleteBaziChartV1Schema,
  StrictZiweiChartV1Schema
} from "../charts/bazi-detail-contract.js";
import { parseBoundBaziDetail } from "../charts/bazi-detail-fingerprints.js";
import {
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema
} from "../../shared/provided-time-contracts.js";

export const CALCULATOR_VERSION = "0.2.0" as const;

export const ChartDocumentExportRequestSchema = z.object({
  candidateId: z.string().min(1),
  targetYear: z.number().int().min(1900).max(2099).optional()
}).strict();

const BaziDetailExportSchema = z.object({
  rulesetVersion: BaziDetailV1Schema.shape.rulesetVersion,
  engine: BaziDetailV1Schema.shape.engine,
  configuration: BaziDetailV1Schema.shape.configuration,
  candidate: BaziDetailCandidateV1Schema
}).strict();

export const ChartDocumentV1Schema = z.object({
  schemaVersion: z.literal(1),
  calculatorVersion: z.string().min(1),
  exportedAt: z.string().datetime({ offset: true }),
  subject: z.object({
    nameOrAlias: z.string().min(1),
    gender: PublicBirthRecordV2Schema.shape.gender
  }).strict(),
  birthInput: z.object({
    calendar: PublicBirthRecordV2Schema.shape.calendar,
    providedTime: PublicBirthRecordV2Schema.shape.providedTime,
    policy: PublicBirthRecordV2Schema.shape.policy
  }).strict(),
  selection: z.object({
    candidateId: z.string().min(1),
    hadAlternatives: z.boolean(),
    rationale: z.string().min(1).nullable()
  }).strict(),
  bazi: z.object({
    chart: StrictCompleteBaziChartV1Schema,
    detail: BaziDetailExportSchema
  }).strict(),
  ziwei: StrictZiweiChartV1Schema,
  targetYear: z.number().int().min(1900).max(2099).optional(),
  warnings: z.array(z.string().min(1))
}).strict();

export type ChartDocumentV1 = z.infer<typeof ChartDocumentV1Schema>;

export type ChartDocumentErrorCode =
  | "CHART_DOCUMENT_CURRENT_INPUT_REQUIRED"
  | "CHART_DOCUMENT_SELECTION_REQUIRED"
  | "CHART_DOCUMENT_CANDIDATE_MISMATCH"
  | "CHART_DOCUMENT_BAZI_DETAIL_REQUIRED"
  | "CHART_DOCUMENT_TARGET_YEAR_INVALID"
  | "CHART_DOCUMENT_SOURCE_INVALID";

const ERROR_MESSAGES: Record<ChartDocumentErrorCode, string> = {
  CHART_DOCUMENT_CURRENT_INPUT_REQUIRED: "请先重新确认最终排盘时间",
  CHART_DOCUMENT_SELECTION_REQUIRED: "请先确定一个排盘候选",
  CHART_DOCUMENT_CANDIDATE_MISMATCH: "请求的候选与已保存选择不一致",
  CHART_DOCUMENT_BAZI_DETAIL_REQUIRED: "八字详盘尚未生成",
  CHART_DOCUMENT_TARGET_YEAR_INVALID: "目标流年不属于当前候选的已计算结果",
  CHART_DOCUMENT_SOURCE_INVALID: "排盘来源未通过格式检查"
};

export class ChartDocumentError extends Error {
  readonly code: ChartDocumentErrorCode;
  readonly statusCode: 409 | 422;

  constructor(code: ChartDocumentErrorCode, statusCode: 409 | 422) {
    super(ERROR_MESSAGES[code]);
    this.name = "ChartDocumentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code: ChartDocumentErrorCode, statusCode: 409 | 422): never {
  throw new ChartDocumentError(code, statusCode);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function buildChartDocumentV1(input: {
  calculatorVersion: string;
  exportedAt: Date;
  storedRevision: Record<string, unknown>;
  requestedCandidateId: string;
  targetYear?: number;
}): ChartDocumentV1 {
  const rawInput = z.record(z.string(), z.unknown()).safeParse(input.storedRevision.input);
  if (!rawInput.success || rawInput.data.schemaVersion !== "2.0.0") {
    return fail("CHART_DOCUMENT_CURRENT_INPUT_REQUIRED", 409);
  }
  if (input.storedRevision.baziDetail === undefined || input.storedRevision.baziDetail === null) {
    return fail("CHART_DOCUMENT_BAZI_DETAIL_REQUIRED", 409);
  }

  let publicInput: z.infer<typeof PublicBirthRecordV2Schema>;
  let timeEvidence: z.infer<typeof TimeEvidenceV2Schema>;
  let charts: z.infer<typeof BaziDetailBaseChartSetSourceSchema>;
  let baziDetail: z.infer<typeof BaziDetailV1Schema>;
  let audit: z.infer<typeof AuditReportV2Schema>;
  let privateName: string | undefined;
  try {
    publicInput = PublicBirthRecordV2Schema.parse(rawInput.data);
    timeEvidence = TimeEvidenceV2Schema.parse(input.storedRevision.timeEvidence);
    charts = BaziDetailBaseChartSetSourceSchema.parse(input.storedRevision.charts);
    baziDetail = BaziDetailV1Schema.parse(input.storedRevision.baziDetail);
    audit = AuditReportV2Schema.parse(input.storedRevision.audit);
    privateName = z.object({ privateName: z.string().trim().min(1).optional() })
      .parse(input.storedRevision.privateContext ?? {}).privateName;
    baziDetail = BaziDetailV1Schema.parse(
      parseBoundBaziDetail({
        publicBirthRecord: publicInput,
        timeEvidence,
        baseChartSet: charts,
        detail: baziDetail
      })
    );
  } catch {
    return fail("CHART_DOCUMENT_SOURCE_INVALID", 422);
  }

  const evidenceCandidateIds = timeEvidence.candidates.map((candidate) => candidate.id);
  const chartCandidateIds = charts.candidates.map((candidate) => candidate.candidateId);
  const detailCandidateIds = baziDetail.candidates.map((candidate) => candidate.candidateId);
  if (
    publicInput.caseId !== timeEvidence.caseId
    || publicInput.caseId !== charts.caseId
    || publicInput.caseId !== audit.caseId
    || !sameIds(evidenceCandidateIds, chartCandidateIds)
    || !sameIds(evidenceCandidateIds, detailCandidateIds)
    || !sameIds(evidenceCandidateIds, audit.candidateIds)
  ) {
    return fail("CHART_DOCUMENT_SOURCE_INVALID", 422);
  }
  if (audit.workflowStatus === "void" || audit.manualDecision.status === "voided") {
    return fail("CHART_DOCUMENT_SOURCE_INVALID", 422);
  }

  const hadAlternatives = evidenceCandidateIds.length > 1;
  if (hadAlternatives && audit.manualDecision.status !== "selected") {
    return fail("CHART_DOCUMENT_SELECTION_REQUIRED", 409);
  }
  const selectedCandidateId = hadAlternatives
    ? audit.manualDecision.status === "selected"
      ? audit.manualDecision.selectedCandidateId
      : fail("CHART_DOCUMENT_SELECTION_REQUIRED", 409)
    : evidenceCandidateIds[0];
  if (selectedCandidateId !== input.requestedCandidateId) {
    return fail("CHART_DOCUMENT_CANDIDATE_MISMATCH", 409);
  }

  const selectedTime = timeEvidence.candidates.find((candidate) => candidate.id === selectedCandidateId);
  const selectedChart = charts.candidates.find((candidate) => candidate.candidateId === selectedCandidateId);
  const selectedDetail = baziDetail.candidates.find((candidate) => candidate.candidateId === selectedCandidateId);
  if (selectedTime === undefined || selectedChart === undefined || selectedDetail === undefined) {
    return fail("CHART_DOCUMENT_SOURCE_INVALID", 422);
  }

  if (input.targetYear !== undefined) {
    const targetYearIsValid = Number.isInteger(input.targetYear)
      && selectedChart.bazi.annualFortunes.some((fortune) => fortune.year === input.targetYear)
      && selectedDetail.annualDetails.some((detail) => detail.year === input.targetYear)
      && selectedChart.ziwei.yearlyFortunes.some((fortune) => fortune.targetYear === input.targetYear);
    if (!targetYearIsValid) {
      return fail("CHART_DOCUMENT_TARGET_YEAR_INVALID", 422);
    }
  }

  const warnings = [...new Set([
    ...selectedTime.warnings,
    ...timeEvidence.issues
      .filter((issue) => issue.candidateIds.includes(selectedCandidateId))
      .map((issue) => issue.message)
  ])];

  try {
    return ChartDocumentV1Schema.parse({
      schemaVersion: 1,
      calculatorVersion: input.calculatorVersion,
      exportedAt: input.exportedAt.toISOString(),
      subject: {
        nameOrAlias: privateName ?? publicInput.alias,
        gender: publicInput.gender
      },
      birthInput: {
        calendar: publicInput.calendar,
        providedTime: publicInput.providedTime,
        policy: publicInput.policy
      },
      selection: {
        candidateId: selectedCandidateId,
        hadAlternatives,
        rationale: hadAlternatives && audit.manualDecision.status === "selected"
          ? audit.manualDecision.rationale
          : null
      },
      bazi: {
        chart: selectedChart.bazi,
        detail: {
          rulesetVersion: baziDetail.rulesetVersion,
          engine: baziDetail.engine,
          configuration: baziDetail.configuration,
          candidate: selectedDetail
        }
      },
      ziwei: selectedChart.ziwei,
      ...(input.targetYear === undefined ? {} : { targetYear: input.targetYear }),
      warnings
    });
  } catch {
    return fail("CHART_DOCUMENT_SOURCE_INVALID", 422);
  }
}

export function chartDocumentFilename(exportedAt: Date): string {
  const compact = exportedAt.toISOString()
    .replace(/[-:]/gu, "")
    .slice(0, 13)
    .replace("T", "-");
  return `bazi-ziwei-chart-${compact}.json`;
}
