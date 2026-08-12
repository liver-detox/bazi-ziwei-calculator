import { z } from "zod";

import {
  AuditReportV1Schema,
  AuditReportV2Schema,
  DualTrackChartSetAuditSchema
} from "../../audit/index.js";
import { BaziDetailV1Schema, parseBoundBaziDetail } from "../../charts/index.js";
import { canonicalJson, sha256Bytes } from "../../storage/canonical.js";
import {
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema
} from "../../../shared/contracts.js";
import { computeHandoffFingerprintV2 } from "../fingerprints.js";
import {
  CaseIdSchema,
  ComparisonIdSchema,
  ReferenceSetIdSchema,
  RevisionIdSchema,
  ReviewRevisionIdSchema,
  Sha256FingerprintSchema
} from "./common.js";
import { EventAppendixV1Schema } from "./handoff-package.js";
import {
  HumanVerificationV1Schema,
  HumanVerificationV2Schema
} from "./human-verification.js";

const nonEmptyText = z.string().refine((value) => value.trim().length >= 1, "文本在 trim 后不能为空");
const AllowedAnalysisModesSchema = AuditReportV1Schema.shape.allowedAnalysisModes;

function canonicalArtifactSha256(value: unknown): string {
  return `sha256:${sha256Bytes(canonicalJson(value))}`;
}

const RulesAndDependenciesV2Schema = z.object({
  core: z.object({
    rules: z.record(z.string(), z.string()),
    dependencies: z.record(z.string(), z.string())
  }).strict(),
  review: z.object({
    unknownBirthplaceRule: nonEmptyText,
    fieldRegistry: nonEmptyText,
    comparisonProfile: nonEmptyText,
    referenceKeyset: nonEmptyText,
    canonicalization: z.literal("json-canonicalize@2.0.0")
  }).strict()
}).strict();

const ComparisonSummaryV2Schema = z.object({
  totalRows: z.number().int().nonnegative(),
  byMachineStatus: z.object({
    match: z.number().int().nonnegative(),
    different: z.number().int().nonnegative(),
    not_covered: z.number().int().nonnegative(),
    not_comparable: z.number().int().nonnegative()
  }).strict(),
  byMateriality: z.object({
    none: z.number().int().nonnegative(),
    chart_change: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative()
  }).strict(),
  sourceConflictRows: z.number().int().nonnegative()
}).strict();

const ReadinessV2Schema = z.object({
  auditLevel: z.enum(["A", "B", "C", "D"]),
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  verificationStatus: z.enum(["review", "confirmed", "blocked"]),
  coverageStatus: z.enum(["complete", "partial", "none"]),
  pilotGate: z.enum(["ready", "conditional", "blocked", "void"]),
  coreAllowedModes: AllowedAnalysisModesSchema,
  finalAllowedModes: AllowedAnalysisModesSchema
}).strict();

const LimitationV2Schema = z.object({
  code: nonEmptyText,
  severity: z.enum(["info", "warning", "blocking"]),
  summary: nonEmptyText
}).strict();

const ModelPolicyV2Schema = z.object({
  factsAndInterpretationSeparated: z.literal(true),
  parallelCandidatesRequired: z.literal(true),
  retainAuditMetadata: z.literal(true),
  localOperatorNotDigitalSignature: z.literal(true),
  privateInferenceForbidden: z.literal(true),
  allowedAnalysisModes: AllowedAnalysisModesSchema
}).strict();

export const HandoffBaziDetailV2Schema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_included") }).strict(),
  z.object({
    status: z.literal("included"),
    fingerprint: Sha256FingerprintSchema,
    artifactSha256: Sha256FingerprintSchema,
    value: BaziDetailV1Schema
  }).strict()
]);

export const HandoffPackageV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  packageContractVersion: z.literal("CyberSaga-Handoff-v2"),
  subjectContract: z.enum(["provided_time_v2", "provided_time_detail_v3"]),
  rulesAndDependencies: RulesAndDependenciesV2Schema,
  case: z.object({ caseId: CaseIdSchema, alias: nonEmptyText }).strict(),
  subjectRevision: z.object({
    revisionId: RevisionIdSchema,
    contentFingerprint: Sha256FingerprintSchema
  }).strict(),
  reviewRevision: z.object({
    reviewRevisionId: ReviewRevisionIdSchema,
    verificationFingerprint: Sha256FingerprintSchema
  }).strict(),
  reference: z.object({
    referenceSetId: ReferenceSetIdSchema,
    referenceSetFingerprint: Sha256FingerprintSchema
  }).strict(),
  comparison: z.object({
    comparisonId: ComparisonIdSchema,
    comparisonFingerprint: Sha256FingerprintSchema,
    summary: ComparisonSummaryV2Schema
  }).strict(),
  birthRecord: PublicBirthRecordV2Schema,
  timeEvidence: TimeEvidenceV2Schema,
  charts: DualTrackChartSetAuditSchema,
  baziDetail: HandoffBaziDetailV2Schema,
  audit: z.union([AuditReportV1Schema, AuditReportV2Schema]),
  verification: z.union([HumanVerificationV1Schema, HumanVerificationV2Schema]),
  readiness: ReadinessV2Schema,
  limitations: z.array(LimitationV2Schema),
  modelPolicy: ModelPolicyV2Schema,
  eventAppendix: EventAppendixV1Schema.optional(),
  handoffFingerprint: Sha256FingerprintSchema
}).strict().superRefine((handoff, context) => {
  const mismatch = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", message, path });
  };
  if (Object.hasOwn(handoff, "eventAppendix") && handoff.eventAppendix === undefined) {
    mismatch(["eventAppendix"], "eventAppendix 未启用时必须省略");
  }
  if ([
    handoff.birthRecord.caseId,
    handoff.timeEvidence.caseId,
    handoff.charts.caseId,
    handoff.audit.caseId,
    handoff.verification.caseId
  ].some((caseId) => caseId !== handoff.case.caseId)) {
    mismatch(["case", "caseId"], "caseId 必须与全部内嵌对象一致");
  }
  if (handoff.case.alias !== handoff.birthRecord.alias) {
    mismatch(["case", "alias"], "case alias 必须与公开出生记录一致");
  }
  if (
    handoff.subjectRevision.revisionId !== handoff.audit.revisionId
    || handoff.subjectRevision.revisionId !== handoff.verification.subjectRevisionId
  ) mismatch(["subjectRevision", "revisionId"], "核心修订 ID 必须一致");
  if (handoff.subjectRevision.contentFingerprint !== handoff.verification.subjectRevisionContentFingerprint) {
    mismatch(["subjectRevision", "contentFingerprint"], "核心修订指纹必须与签认一致");
  }
  if (handoff.verification.auditContentFingerprint !== `sha256:${handoff.audit.contentFingerprint.value}`) {
    mismatch(["verification", "auditContentFingerprint"], "审计指纹必须一致");
  }
  if (
    handoff.reviewRevision.reviewRevisionId !== handoff.verification.reviewRevisionId
    || handoff.reviewRevision.verificationFingerprint !== handoff.verification.verificationFingerprint
  ) mismatch(["reviewRevision"], "复核修订必须与签认一致");
  if (
    handoff.reference.referenceSetId !== handoff.verification.referenceSetId
    || handoff.reference.referenceSetFingerprint !== handoff.verification.referenceSetFingerprint
  ) mismatch(["reference"], "参考集必须与签认一致");
  if (
    handoff.comparison.comparisonId !== handoff.verification.comparisonId
    || handoff.comparison.comparisonFingerprint !== handoff.verification.comparisonFingerprint
  ) mismatch(["comparison"], "比较身份必须与签认一致");

  if (handoff.subjectContract === "provided_time_v2") {
    if (handoff.audit.schemaVersion !== "1.0.0" || handoff.verification.schemaVersion !== "1.0.0") {
      mismatch(["subjectContract"], "历史 V3 主体必须使用 V1 审计与签认");
    }
    if (handoff.baziDetail.status !== "not_included") {
      mismatch(["baziDetail"], "历史 V3 主体不得声称包含八字详盘");
    }
    if (!handoff.limitations.some((item) => item.summary.includes("未包含八字详盘"))) {
      mismatch(["limitations"], "历史 V3 交接必须声明未包含八字详盘");
    }
  } else {
    if (handoff.audit.schemaVersion !== "2.0.0" || handoff.verification.schemaVersion !== "2.0.0") {
      mismatch(["subjectContract"], "V4 主体必须使用 V2 审计与签认");
    }
    if (
      handoff.verification.schemaVersion === "2.0.0"
      && canonicalArtifactSha256(handoff.charts) !== handoff.verification.chartsArtifactSha256
    ) mismatch(["charts"], "基础盘规范文件字节必须与 Review 证据一致");
    if (handoff.baziDetail.status !== "included") {
      mismatch(["baziDetail"], "V4 交接必须包含全量受验详盘");
    } else if (handoff.verification.schemaVersion === "2.0.0") {
      if (
        handoff.baziDetail.fingerprint !== handoff.baziDetail.value.detailFingerprint
        || handoff.baziDetail.fingerprint !== handoff.verification.baziDetailFingerprint
        || handoff.baziDetail.artifactSha256 !== handoff.verification.baziDetailArtifactSha256
        || canonicalArtifactSha256(handoff.baziDetail.value) !== handoff.baziDetail.artifactSha256
      ) mismatch(["baziDetail"], "详盘 Review/文件/内容指纹必须完全一致");
      try {
        parseBoundBaziDetail({
          publicBirthRecord: handoff.birthRecord,
          timeEvidence: handoff.timeEvidence,
          baseChartSet: handoff.charts as never,
          detail: handoff.baziDetail.value
        });
      } catch {
        mismatch(["baziDetail", "value"], "详盘必须绑定当前候选集、基础盘与目标年");
      }
    }
  }

  const summary = handoff.comparison.summary;
  if (summary.byMachineStatus.match + summary.byMachineStatus.different
    + summary.byMachineStatus.not_covered + summary.byMachineStatus.not_comparable !== summary.totalRows) {
    mismatch(["comparison", "summary", "byMachineStatus"], "machineStatus 计数必须等于 totalRows");
  }
  if (summary.byMateriality.none + summary.byMateriality.chart_change
    + summary.byMateriality.unresolved !== summary.totalRows) {
    mismatch(["comparison", "summary", "byMateriality"], "materiality 计数必须等于 totalRows");
  }
  if (summary.sourceConflictRows > summary.totalRows) {
    mismatch(["comparison", "summary", "sourceConflictRows"], "sourceConflictRows 不能超过 totalRows");
  }
  if (
    handoff.readiness.auditLevel !== handoff.audit.auditLevel
    || handoff.readiness.workflowStatus !== handoff.audit.workflowStatus
    || handoff.readiness.verificationStatus !== handoff.verification.verificationStatus
    || handoff.readiness.coverageStatus !== handoff.verification.coverageStatus
    || JSON.stringify(handoff.readiness.coreAllowedModes) !== JSON.stringify(handoff.audit.allowedAnalysisModes)
  ) mismatch(["readiness"], "readiness 必须与审计和签认一致");
  const finalModes = handoff.readiness.finalAllowedModes;
  const expectedFinalOrder = handoff.readiness.coreAllowedModes.filter((mode) => finalModes.includes(mode));
  if (new Set(finalModes).size !== finalModes.length || JSON.stringify(finalModes) !== JSON.stringify(expectedFinalOrder)) {
    mismatch(["readiness", "finalAllowedModes"], "最终允许模式必须是核心模式的有序子集");
  }
  if (JSON.stringify(handoff.modelPolicy.allowedAnalysisModes) !== JSON.stringify(finalModes)) {
    mismatch(["modelPolicy", "allowedAnalysisModes"], "模型允许模式必须与 readiness 一致");
  }
  if (handoff.handoffFingerprint !== computeHandoffFingerprintV2(handoff)) {
    mismatch(["handoffFingerprint"], "handoffFingerprint 必须与 V2 交接语义预映像一致");
  }
});

export type HandoffBaziDetailV2 = z.infer<typeof HandoffBaziDetailV2Schema>;
export type HandoffPackageV2 = z.infer<typeof HandoffPackageV2Schema>;
