import { z } from "zod";

import {
  AUDIT_CONTRACT_VERSION_V3,
  AUDIT_CONTRACT_VERSION_V4,
  AuditReportV1Schema,
  AuditReportV2Schema,
  BaziChartAuditSchema,
  ZiweiChartAuditSchema,
  type AuditReportV1,
  type AuditReportV2
} from "../audit/index.js";
import {
  BaziDetailV1Schema,
  parseBoundBaziDetail,
  type BaziDetailV1
} from "../charts/index.js";
import type { DualTrackChartSetV1 } from "../charts/types.js";
import { canonicalJson, sha256Bytes } from "../storage/canonical.js";
import {
  computeRevisionContentFingerprint,
  computeRevisionContentFingerprintV4
} from "../storage/revision-content-fingerprint.js";
import {
  BirthRecordV1Schema,
  ProvidedTimeBasisV1Schema,
  PublicBirthRecordV2Schema,
  TimeEvidenceV1Schema,
  TimeEvidenceV2Schema,
  type BirthRecordV1,
  type PublicBirthRecordV2,
  type TimeEvidenceV1,
  type TimeEvidenceV2
} from "../../shared/contracts.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import {
  assessStoredRevisionIdentity,
  type ProvidedTimeDependencyIdentityV4,
  type ProvidedTimeRuleIdentityV4
} from "../workbench/revision-version-identity.js";
import { ReviewError } from "./errors.js";
import { compareUnicodeCodePoints, Sha256FingerprintSchema } from "./contracts/common.js";

const CandidateChartCommonShape = {
  candidateId: z.string().min(1),
  dayBoundary: z.enum(["current", "forward"]),
  calendarResolutionId: z.string().min(1).optional(),
  calendarBasis: z.enum(["solar", "lunar_regular", "lunar_leap"]).optional(),
  bazi: BaziChartAuditSchema,
  ziwei: ZiweiChartAuditSchema
};

const CandidateChartV1Schema = z.object({
  ...CandidateChartCommonShape,
  basis: z.enum(["civil_iana", "civil_standard", "gap_before", "gap_after", "apparent_solar"])
}).strict();

const CandidateChartV2Schema = z.object({
  ...CandidateChartCommonShape,
  basis: z.enum(["apparent_solar_provided", "civil_clock_provided"])
}).strict();

const DualTrackChartSetV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  timeRulesetVersion: z.string().min(1),
  engineVersions: z.object({
    bazi: z.object({ name: z.literal("lunar-typescript"), version: z.literal("1.8.6") }).strict(),
    ziwei: z.object({ name: z.literal("iztro"), version: z.literal("2.5.8") }).strict()
  }).strict(),
  chartRulesetVersions: z.object({
    bazi: z.literal("CyberSaga-Bazi-v1"),
    ziwei: z.literal("CyberSaga-Ziwei-v1")
  }).strict(),
  targetYears: z.array(z.number().int().min(1900).max(2099)).min(1),
  candidates: z.array(CandidateChartV1Schema).min(1)
}).strict();

const DualTrackChartSetV2Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  timeRulesetVersion: z.literal("CyberSaga-Provided-Time-v1"),
  engineVersions: z.object({
    bazi: z.object({ name: z.literal("lunar-typescript"), version: z.literal("1.8.6") }).strict(),
    ziwei: z.object({ name: z.literal("iztro"), version: z.literal("2.5.8") }).strict()
  }).strict(),
  chartRulesetVersions: z.object({
    bazi: z.literal("CyberSaga-Bazi-v1"),
    ziwei: z.literal("CyberSaga-Ziwei-v1")
  }).strict(),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  candidates: z.array(CandidateChartV2Schema).min(1)
}).strict();

const ManifestFileSchema = z.object({
  path: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: Sha256FingerprintSchema,
  private: z.boolean()
}).strict();

const RevisionManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  auditContractVersion: z.string().min(1).optional(),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  revisionId: z.string().regex(/^R\d{3}$/u),
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  createdAt: z.iso.datetime({ offset: true }),
  rules: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
  contentFingerprint: Sha256FingerprintSchema,
  files: z.array(ManifestFileSchema).min(1)
}).strict();

const UnknownBirthplaceAttestationSchema = z.object({
  mode: z.literal("beijing_time_basis"),
  confirmedBy: z.literal("local_operator"),
  noticeVersion: z.literal("CyberSaga-Unknown-Birthplace-Notice-v1")
}).strict();

const CalculationContextSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  provenanceFlags: z.array(z.string().min(1)),
  unknownBirthplaceAttestation: UnknownBirthplaceAttestationSchema.optional(),
  precisionCoverage: z.object({
    mode: z.enum(["point", "interval", "branch"]),
    complete: z.boolean(),
    candidateIds: z.array(z.string().min(1)),
    note: z.string().min(1).nullable(),
    proof: z.unknown().nullable()
  }).strict()
}).strict();

const CalculationContextV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  timeInputBasis: ProvidedTimeBasisV1Schema,
  provenanceFlags: z.array(z.enum([
    "provided_time_apparent_solar",
    "provided_time_civil_clock",
    "provided_time_source_note_present"
  ])).max(3),
  precisionCoverage: z.object({
    mode: z.enum(["point", "interval", "branch"]),
    complete: z.boolean(),
    candidateIds: z.array(z.string().min(1)),
    note: z.string().min(1).nullable(),
    proof: z.unknown().nullable()
  }).strict()
}).strict();

const CalculationContextV2FallbackSchema = z.object({
  schemaVersion: z.literal("2.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  timeInputBasis: ProvidedTimeBasisV1Schema,
  provenanceFlags: z.array(z.enum([
    "provided_time_apparent_solar",
    "provided_time_civil_clock",
    "provided_time_source_note_present"
  ])).max(3),
  precisionCoverage: z.object({
    mode: z.enum(["point", "interval", "branch"]),
    complete: z.boolean(),
    candidateIds: z.array(z.string().min(1)),
    note: z.string().min(1).nullable(),
    proof: z.unknown().nullable()
  }).strict(),
  baziDetailGenerationStatus: z.literal("retryable_failure")
}).strict();

const StoredCalculationContextV2Schema = z.union([
  CalculationContextV2Schema,
  CalculationContextV2FallbackSchema
]);

const SourceImportReferenceSchema = z.object({
  sha256: Sha256FingerprintSchema,
  byteLength: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1)
}).strict();

const PublicRevisionSnapshotV1Schema = z.object({
  input: BirthRecordV1Schema,
  timeEvidence: TimeEvidenceV1Schema,
  charts: DualTrackChartSetV1Schema,
  audit: AuditReportV1Schema,
  manifest: RevisionManifestSchema,
  calculationContext: CalculationContextSchema.optional(),
  sourceImportReference: SourceImportReferenceSchema.optional()
}).passthrough();

const PublicRevisionSnapshotV2Schema = z.object({
  input: PublicBirthRecordV2Schema,
  timeEvidence: TimeEvidenceV2Schema,
  charts: DualTrackChartSetV2Schema,
  audit: AuditReportV1Schema,
  manifest: RevisionManifestSchema.extend({
    auditContractVersion: z.literal(AUDIT_CONTRACT_VERSION_V3)
  }).strict(),
  calculationContext: StoredCalculationContextV2Schema,
  sourceImportReference: z.never().optional()
}).passthrough();

const PublicRevisionSnapshotV3Schema = z.object({
  input: PublicBirthRecordV2Schema,
  timeEvidence: TimeEvidenceV2Schema,
  charts: DualTrackChartSetV2Schema,
  baziDetail: BaziDetailV1Schema,
  audit: AuditReportV2Schema,
  manifest: RevisionManifestSchema.extend({
    auditContractVersion: z.literal(AUDIT_CONTRACT_VERSION_V4)
  }).strict(),
  calculationContext: CalculationContextV2Schema,
  sourceImportReference: z.never().optional()
}).passthrough();

export interface ReviewSubjectV1 {
  subjectContract: "location_time_v1";
  caseId: string;
  revisionId: string;
  revisionContentFingerprint: string;
  auditContentFingerprint: string;
  chartsArtifactSha256: string;
  birthRecord: BirthRecordV1;
  timeEvidence: TimeEvidenceV1;
  charts: DualTrackChartSetV1;
  audit: AuditReportV1;
  retainedCandidateIds: string[];
}

export interface ReviewSubjectV2 {
  subjectContract: "provided_time_v2";
  caseId: string;
  revisionId: string;
  revisionContentFingerprint: string;
  auditContentFingerprint: string;
  chartsArtifactSha256: string;
  birthRecord: PublicBirthRecordV2;
  timeEvidence: TimeEvidenceV2;
  charts: DualTrackChartSetV1;
  audit: AuditReportV1;
  retainedCandidateIds: string[];
}

export interface ReviewSubjectV3 {
  subjectContract: "provided_time_detail_v3";
  caseId: string;
  revisionId: string;
  revisionContentFingerprint: string;
  auditContentFingerprint: string;
  chartsArtifactSha256: string;
  baziDetailArtifactSha256: string;
  baziDetailFingerprint: string;
  birthRecord: PublicBirthRecordV2;
  timeEvidence: TimeEvidenceV2;
  charts: DualTrackChartSetV1;
  baziDetail: BaziDetailV1;
  audit: AuditReportV2;
  retainedCandidateIds: string[];
}

export type ReviewSubject = ReviewSubjectV1 | ReviewSubjectV2 | ReviewSubjectV3;

function invalid(code: string, message: string, cause?: unknown): ReviewError {
  return new ReviewError(code, message, 422, cause === undefined ? undefined : { cause });
}

function sortedUnique(values: readonly string[], label: string): string[] {
  if (new Set(values).size !== values.length) {
    throw invalid("REVIEW_SUBJECT_CANDIDATES_INVALID", `${label} candidateId 必须唯一`);
  }
  return [...values].sort(compareUnicodeCodePoints);
}

function assertSameStrings(left: readonly string[], right: readonly string[], message: string): void {
  if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
    throw invalid("REVIEW_SUBJECT_CANDIDATES_MISMATCH", message);
  }
}

function assertChartCandidateBindings(
  charts: DualTrackChartSetV1,
  timeEvidence: TimeEvidenceV1 | TimeEvidenceV2
): void {
  const timeById = new Map(timeEvidence.candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of charts.candidates) {
    const time = timeById.get(candidate.candidateId);
    if (
      time === undefined
      || candidate.bazi.candidateId !== candidate.candidateId
      || candidate.ziwei.candidateId !== candidate.candidateId
      || candidate.basis !== time.basis
      || candidate.dayBoundary !== time.dayBoundary
      || candidate.calendarResolutionId !== time.calendarResolutionId
      || candidate.calendarBasis !== time.calendarBasis
    ) {
      throw invalid(
        "REVIEW_SUBJECT_CANDIDATE_BINDING_INVALID",
        `候选盘与时间证据身份不一致: ${candidate.candidateId}`
      );
    }
  }
}

export function parseReviewSubject(snapshot: unknown): ReviewSubject {
  const marker = z.object({
    manifest: z.object({ auditContractVersion: z.unknown().optional() }).passthrough()
  }).passthrough().safeParse(snapshot);
  if (!marker.success) {
    throw invalid("REVIEW_SUBJECT_SCHEMA_INVALID", "核心修订快照缺少 manifest", marker.error);
  }
  const auditContractVersion = marker.data.manifest.auditContractVersion;
  const detailedSubject = auditContractVersion === AUDIT_CONTRACT_VERSION_V4;
  const providedTimeSubject = detailedSubject || auditContractVersion === AUDIT_CONTRACT_VERSION_V3;
  const parsed = detailedSubject
    ? PublicRevisionSnapshotV3Schema.safeParse(snapshot)
    : providedTimeSubject
      ? PublicRevisionSnapshotV2Schema.safeParse(snapshot)
      : PublicRevisionSnapshotV1Schema.safeParse(snapshot);
  if (!parsed.success) {
    throw invalid(
      "REVIEW_SUBJECT_SCHEMA_INVALID",
      detailedSubject
        ? "核心修订快照不符合 strict provided-time detail V3 契约"
        : providedTimeSubject
        ? "核心修订快照不符合 strict provided-time V2 契约"
        : "核心修订快照不符合 strict V1 契约",
      parsed.error
    );
  }
  const value = parsed.data;
  // Fingerprints bind the public snapshot bytes' actual JSON values, not values
  // that a schema default or transform could synthesize while validating them.
  const actual = snapshot as Record<string, unknown>;
  const { input, timeEvidence, charts, audit, manifest } = value;
  if ("privateName" in input && input.privateName !== undefined) {
    throw invalid("REVIEW_SUBJECT_PRIVATE_INPUT", "公开核心修订快照不得包含 privateName");
  }
  if (
    input.caseId !== manifest.caseId
    || timeEvidence.caseId !== manifest.caseId
    || charts.caseId !== manifest.caseId
    || audit.caseId !== manifest.caseId
  ) {
    throw invalid("REVIEW_SUBJECT_CASE_MISMATCH", "快照内 caseId 不一致");
  }
  if (
    audit.revisionId !== manifest.revisionId
    || audit.auditReportId !== `AUD-${manifest.caseId}-${manifest.revisionId}`
  ) {
    throw invalid("REVIEW_SUBJECT_REVISION_MISMATCH", "审计报告与修订身份不一致");
  }
  if (audit.workflowStatus !== manifest.workflowStatus) {
    throw invalid("REVIEW_SUBJECT_WORKFLOW_MISMATCH", "manifest 与 audit 流程状态不一致");
  }
  if (manifest.workflowStatus === "void" || audit.manualDecision.status === "voided") {
    throw invalid("REVIEW_SUBJECT_VOID", "已作废核心修订不得比较");
  }
  if (timeEvidence.rulesetVersion !== charts.timeRulesetVersion) {
    throw invalid("REVIEW_SUBJECT_RULESET_MISMATCH", "时间证据与盘集规则版本不一致");
  }
  if (sourceRecordFingerprint(input) !== timeEvidence.sourceRecordFingerprint) {
    throw invalid("REVIEW_SUBJECT_SOURCE_FINGERPRINT_MISMATCH", "时间证据不属于当前公开出生记录");
  }
  if (providedTimeSubject) {
    const providedInput = input as PublicBirthRecordV2;
    const providedEvidence = timeEvidence as TimeEvidenceV2;
    const context = value.calculationContext as z.infer<typeof CalculationContextV2Schema>;
    const expectedFlag = providedInput.providedTime.basis === "apparent_solar_provided"
      ? "provided_time_apparent_solar"
      : "provided_time_civil_clock";
    if (
      providedEvidence.originalTimeBasis !== providedInput.providedTime.basis
      || context.timeInputBasis !== providedInput.providedTime.basis
      || audit.timeInputBoundary?.basis !== providedInput.providedTime.basis
      || !context.provenanceFlags.includes(expectedFlag)
      || context.provenanceFlags.includes(expectedFlag === "provided_time_apparent_solar"
        ? "provided_time_civil_clock"
        : "provided_time_apparent_solar")
    ) {
      throw invalid("REVIEW_SUBJECT_TIME_BOUNDARY_MISMATCH", "用户提供时间的口径边界不一致");
    }
  }

  const identity = assessStoredRevisionIdentity({
    ...(manifest.auditContractVersion === undefined
      ? {}
      : { auditContractVersion: manifest.auditContractVersion }),
    manifestRules: manifest.rules,
    manifestDependencies: manifest.dependencies,
    report: audit
  });
  if (identity.trust === "invalid") {
    throw invalid("REVIEW_SUBJECT_REVISION_IDENTITY_INVALID", "修订规则与依赖身份不可信");
  }

  const timeCandidateIds = sortedUnique(timeEvidence.candidates.map((candidate) => candidate.id), "timeEvidence");
  const chartCandidateIds = sortedUnique(charts.candidates.map((candidate) => candidate.candidateId), "charts");
  const auditCandidateIds = sortedUnique(audit.candidateIds, "audit");
  assertSameStrings(timeCandidateIds, chartCandidateIds, "timeEvidence 与 charts 候选集不一致");
  assertSameStrings(timeCandidateIds, auditCandidateIds, "timeEvidence 与 audit 候选集不一致");
  assertChartCandidateBindings(charts as DualTrackChartSetV1, timeEvidence);

  if (new Set(charts.targetYears).size !== charts.targetYears.length) {
    throw invalid("REVIEW_SUBJECT_TARGET_YEARS_INVALID", "targetYears 必须唯一");
  }
  if (
    value.calculationContext !== undefined
    && (
      value.calculationContext.targetYears.length !== charts.targetYears.length
      || value.calculationContext.targetYears.some((year, index) => year !== charts.targetYears[index])
    )
  ) {
    throw invalid("REVIEW_SUBJECT_CONTEXT_MISMATCH", "calculationContext.targetYears 与 charts 不一致");
  }

  const chartsFiles = manifest.files.filter((file) => file.path === "charts.json" && !file.private);
  if (chartsFiles.length !== 1) {
    throw invalid("REVIEW_SUBJECT_CHARTS_MANIFEST_INVALID", "manifest.files 必须恰有一个公开 charts.json");
  }
  const chartsBytes = canonicalJson(actual.charts);
  const chartsArtifactSha256 = `sha256:${sha256Bytes(chartsBytes)}`;
  if (
    chartsFiles[0].sha256 !== chartsArtifactSha256
    || chartsFiles[0].byteLength !== Buffer.byteLength(chartsBytes, "utf8")
  ) {
    throw invalid("REVIEW_SUBJECT_CHARTS_HASH_MISMATCH", "charts.json 规范字节与 manifest 证据不匹配");
  }

  let boundBaziDetail: BaziDetailV1 | undefined;
  let baziDetailArtifactSha256: string | undefined;
  if (detailedSubject) {
    const detailFiles = manifest.files.filter((file) => file.path === "bazi-detail.json");
    if (detailFiles.length !== 1 || detailFiles[0].private) {
      throw invalid("REVIEW_SUBJECT_BAZI_DETAIL_MANIFEST_INVALID", "manifest.files 必须恰有一个公开 bazi-detail.json");
    }
    const detailBytes = canonicalJson(actual.baziDetail);
    baziDetailArtifactSha256 = `sha256:${sha256Bytes(detailBytes)}`;
    if (
      detailFiles[0].sha256 !== baziDetailArtifactSha256
      || detailFiles[0].byteLength !== Buffer.byteLength(detailBytes, "utf8")
    ) {
      throw invalid(
        "REVIEW_SUBJECT_BAZI_DETAIL_HASH_MISMATCH",
        "bazi-detail.json 规范字节与 manifest 证据不匹配"
      );
    }
    try {
      boundBaziDetail = parseBoundBaziDetail({
        publicBirthRecord: input as PublicBirthRecordV2,
        timeEvidence: timeEvidence as TimeEvidenceV2,
        baseChartSet: charts as DualTrackChartSetV1,
        detail: actual.baziDetail
      });
    } catch (error) {
      throw invalid("REVIEW_SUBJECT_BAZI_DETAIL_BINDING_INVALID", "八字详盘不属于当前核心主体", error);
    }
  }

  const sourceImport = value.sourceImportReference === undefined
    ? undefined
    : {
        sha256: value.sourceImportReference.sha256,
        byteLength: value.sourceImportReference.byteLength
      };
  const expectedRevisionFingerprint = detailedSubject
    ? computeRevisionContentFingerprintV4(AUDIT_CONTRACT_VERSION_V4, {
        publicInput: input as PublicBirthRecordV2,
        timeEvidence: timeEvidence as TimeEvidenceV2,
        charts: charts as DualTrackChartSetV1,
        baziDetail: boundBaziDetail!,
        audit: audit as AuditReportV2,
        calculationContext: actual.calculationContext as Record<string, unknown>,
        workflowStatus: manifest.workflowStatus,
        auditContractVersion: AUDIT_CONTRACT_VERSION_V4,
        rules: manifest.rules as unknown as ProvidedTimeRuleIdentityV4,
        dependencies: manifest.dependencies as unknown as ProvidedTimeDependencyIdentityV4
      })
    : computeRevisionContentFingerprint({
        publicInput: actual.input as Record<string, unknown>,
        timeEvidence: actual.timeEvidence,
        charts: actual.charts,
        audit: actual.audit,
        sourceImport,
        calculationContext: actual.calculationContext as Record<string, unknown> | undefined,
        workflowStatus: manifest.workflowStatus,
        auditContractVersion: manifest.auditContractVersion,
        rules: manifest.rules,
        dependencies: manifest.dependencies
      });
  if (manifest.contentFingerprint !== expectedRevisionFingerprint) {
    throw invalid(
      "REVIEW_SUBJECT_CONTENT_FINGERPRINT_MISMATCH",
      "revision content fingerprint 与快照实际语义不一致"
    );
  }

  const retainedCandidateIds = audit.manualDecision.status === "selected"
    ? [audit.manualDecision.selectedCandidateId]
    : [...timeCandidateIds];
  if (retainedCandidateIds.some((candidateId) => !timeCandidateIds.includes(candidateId))) {
    throw invalid("REVIEW_SUBJECT_RETAINED_INVALID", "保留候选不存在于核心主体");
  }
  retainedCandidateIds.sort(compareUnicodeCodePoints);

  const common = {
    caseId: manifest.caseId,
    revisionId: manifest.revisionId,
    revisionContentFingerprint: manifest.contentFingerprint,
    auditContentFingerprint: `sha256:${audit.contentFingerprint.value}`,
    chartsArtifactSha256,
    birthRecord: input,
    timeEvidence,
    charts: charts as DualTrackChartSetV1,
    audit,
    retainedCandidateIds
  };
  if (detailedSubject) {
    return {
      subjectContract: "provided_time_detail_v3",
      ...common,
      baziDetailArtifactSha256: baziDetailArtifactSha256!,
      baziDetailFingerprint: boundBaziDetail!.detailFingerprint,
      baziDetail: boundBaziDetail!,
      audit: audit as AuditReportV2
    } as ReviewSubjectV3;
  }
  return {
    subjectContract: providedTimeSubject ? "provided_time_v2" : "location_time_v1",
    ...common
  } as ReviewSubjectV1 | ReviewSubjectV2;
}
