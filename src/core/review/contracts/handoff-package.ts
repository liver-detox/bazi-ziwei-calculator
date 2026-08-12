import { z } from "zod";

import {
  computeEventAppendixFingerprint,
  computeEventFingerprint,
  computeHandoffFingerprint
} from "../fingerprints.js";

import {
  AuditReportV1Schema,
  DualTrackChartSetAuditSchema
} from "../../audit/index.js";
import {
  BirthRecordV1Schema,
  TimeEvidenceV1Schema
} from "../../../shared/contracts.js";
import {
  CaseIdSchema,
  ComparisonIdSchema,
  ReferenceSetIdSchema,
  RevisionIdSchema,
  ReviewRevisionIdSchema,
  SchemaVersionV1Schema,
  Sha256FingerprintSchema
} from "./common.js";
import { HumanVerificationV1Schema } from "./human-verification.js";

const nonEmptyText = z.string().refine(
  (value) => value.trim().length >= 1,
  "文本在 trim 后不能为空"
);
const AllowedAnalysisModesV1Schema = AuditReportV1Schema.shape.allowedAnalysisModes;

export const RedactedBirthRecordV1Schema = BirthRecordV1Schema.omit({ privateName: true });

export const EventV1Schema = z.object({
  datePrecision: z.enum(["year", "month", "day", "range"]),
  dateText: nonEmptyText,
  summary: nonEmptyText,
  sourceCategory: nonEmptyText,
  confirmedBy: z.literal("local_operator"),
  eventFingerprint: Sha256FingerprintSchema
}).strict().superRefine((event, context) => {
  if (event.eventFingerprint !== computeEventFingerprint(event)) {
    context.addIssue({
      code: "custom",
      message: "eventFingerprint 必须与事件语义预映像一致",
      path: ["eventFingerprint"]
    });
  }
});

export const EventAppendixV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  events: z.array(EventV1Schema).min(1),
  appendixFingerprint: Sha256FingerprintSchema
}).strict().superRefine((appendix, context) => {
  if (appendix.appendixFingerprint !== computeEventAppendixFingerprint(appendix)) {
    context.addIssue({
      code: "custom",
      message: "appendixFingerprint 必须与规范事件集合一致",
      path: ["appendixFingerprint"]
    });
  }
});

const RulesAndDependenciesV1Schema = z.object({
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

const ComparisonSummaryV1Schema = z.object({
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

const ReadinessV1Schema = z.object({
  auditLevel: z.enum(["A", "B", "C", "D"]),
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  verificationStatus: z.enum(["review", "confirmed", "blocked"]),
  coverageStatus: z.enum(["complete", "partial", "none"]),
  pilotGate: z.enum(["ready", "conditional", "blocked", "void"]),
  coreAllowedModes: AllowedAnalysisModesV1Schema,
  finalAllowedModes: AllowedAnalysisModesV1Schema
}).strict();

const LimitationV1Schema = z.object({
  code: nonEmptyText,
  severity: z.enum(["info", "warning", "blocking"]),
  summary: nonEmptyText
}).strict();

const ModelPolicyV1Schema = z.object({
  factsAndInterpretationSeparated: z.literal(true),
  parallelCandidatesRequired: z.literal(true),
  retainAuditMetadata: z.literal(true),
  localOperatorNotDigitalSignature: z.literal(true),
  privateInferenceForbidden: z.literal(true),
  allowedAnalysisModes: AllowedAnalysisModesV1Schema
}).strict();

export const HandoffPackageV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  packageContractVersion: z.literal("CyberSaga-Handoff-v1"),
  rulesAndDependencies: RulesAndDependenciesV1Schema,
  case: z.object({
    caseId: CaseIdSchema,
    alias: nonEmptyText
  }).strict(),
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
    summary: ComparisonSummaryV1Schema
  }).strict(),
  // 2026-08-09: historical V1 handoff only. Provided-time subjects require a
  // separately versioned handoff contract; never widen this field in place.
  birthRecord: RedactedBirthRecordV1Schema,
  timeEvidence: TimeEvidenceV1Schema,
  charts: DualTrackChartSetAuditSchema,
  audit: AuditReportV1Schema,
  verification: HumanVerificationV1Schema,
  readiness: ReadinessV1Schema,
  limitations: z.array(LimitationV1Schema),
  modelPolicy: ModelPolicyV1Schema,
  eventAppendix: EventAppendixV1Schema.optional(),
  handoffFingerprint: Sha256FingerprintSchema
}).strict().superRefine((handoff, context) => {
  const mismatch = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", message, path });
  };

  if (Object.hasOwn(handoff, "eventAppendix") && handoff.eventAppendix === undefined) {
    mismatch(["eventAppendix"], "eventAppendix 未启用时必须省略");
  }

  const caseBindings = [
    handoff.birthRecord.caseId,
    handoff.timeEvidence.caseId,
    handoff.charts.caseId,
    handoff.audit.caseId,
    handoff.verification.caseId
  ];
  if (caseBindings.some((caseId) => caseId !== handoff.case.caseId)) {
    mismatch(["case", "caseId"], "caseId 必须与全部内嵌对象一致");
  }
  if (handoff.case.alias !== handoff.birthRecord.alias) {
    mismatch(["case", "alias"], "case alias 必须与脱敏出生记录一致");
  }

  if (
    handoff.subjectRevision.revisionId !== handoff.audit.revisionId
    || handoff.subjectRevision.revisionId !== handoff.verification.subjectRevisionId
  ) {
    mismatch(["subjectRevision", "revisionId"], "核心修订 ID 必须与审计和签认一致");
  }
  if (handoff.subjectRevision.contentFingerprint !== handoff.verification.subjectRevisionContentFingerprint) {
    mismatch(["subjectRevision", "contentFingerprint"], "核心修订指纹必须与签认一致");
  }
  if (handoff.verification.auditContentFingerprint !== `sha256:${handoff.audit.contentFingerprint.value}`) {
    mismatch(["verification", "auditContentFingerprint"], "审计内容指纹必须与内嵌审计一致");
  }
  if (handoff.reviewRevision.reviewRevisionId !== handoff.verification.reviewRevisionId) {
    mismatch(["reviewRevision", "reviewRevisionId"], "复核修订 ID 必须与签认一致");
  }
  if (handoff.reviewRevision.verificationFingerprint !== handoff.verification.verificationFingerprint) {
    mismatch(["reviewRevision", "verificationFingerprint"], "复核修订指纹必须与签认一致");
  }
  if (handoff.reference.referenceSetId !== handoff.verification.referenceSetId) {
    mismatch(["reference", "referenceSetId"], "参考集 ID 必须与签认一致");
  }
  if (handoff.reference.referenceSetFingerprint !== handoff.verification.referenceSetFingerprint) {
    mismatch(["reference", "referenceSetFingerprint"], "参考集指纹必须与签认一致");
  }
  if (handoff.comparison.comparisonId !== handoff.verification.comparisonId) {
    mismatch(["comparison", "comparisonId"], "比较 ID 必须与签认一致");
  }
  if (handoff.comparison.comparisonFingerprint !== handoff.verification.comparisonFingerprint) {
    mismatch(["comparison", "comparisonFingerprint"], "比较指纹必须与签认一致");
  }

  const summary = handoff.comparison.summary;
  const machineTotal = summary.byMachineStatus.match
    + summary.byMachineStatus.different
    + summary.byMachineStatus.not_covered
    + summary.byMachineStatus.not_comparable;
  const materialityTotal = summary.byMateriality.none
    + summary.byMateriality.chart_change
    + summary.byMateriality.unresolved;
  if (machineTotal !== summary.totalRows) {
    mismatch(["comparison", "summary", "byMachineStatus"], "machineStatus 计数总和必须等于 totalRows");
  }
  if (materialityTotal !== summary.totalRows) {
    mismatch(["comparison", "summary", "byMateriality"], "materiality 计数总和必须等于 totalRows");
  }
  if (summary.sourceConflictRows > summary.totalRows) {
    mismatch(["comparison", "summary", "sourceConflictRows"], "sourceConflictRows 不能超过 totalRows");
  }

  if (handoff.readiness.auditLevel !== handoff.audit.auditLevel) {
    mismatch(["readiness", "auditLevel"], "readiness.auditLevel 必须与审计一致");
  }
  if (handoff.readiness.workflowStatus !== handoff.audit.workflowStatus) {
    mismatch(["readiness", "workflowStatus"], "readiness.workflowStatus 必须与审计一致");
  }
  if (handoff.readiness.verificationStatus !== handoff.verification.verificationStatus) {
    mismatch(["readiness", "verificationStatus"], "readiness.verificationStatus 必须与签认一致");
  }
  if (handoff.readiness.coverageStatus !== handoff.verification.coverageStatus) {
    mismatch(["readiness", "coverageStatus"], "readiness.coverageStatus 必须与签认一致");
  }
  if (JSON.stringify(handoff.readiness.coreAllowedModes) !== JSON.stringify(handoff.audit.allowedAnalysisModes)) {
    mismatch(["readiness", "coreAllowedModes"], "核心允许模式必须与审计一致");
  }

  const finalModes = handoff.readiness.finalAllowedModes;
  const expectedFinalOrder = handoff.readiness.coreAllowedModes.filter((mode) => finalModes.includes(mode));
  if (
    new Set(finalModes).size !== finalModes.length
    || JSON.stringify(finalModes) !== JSON.stringify(expectedFinalOrder)
  ) {
    mismatch(["readiness", "finalAllowedModes"], "最终允许模式必须是核心允许模式的有序子集");
  }
  if (JSON.stringify(handoff.modelPolicy.allowedAnalysisModes) !== JSON.stringify(finalModes)) {
    mismatch(["modelPolicy", "allowedAnalysisModes"], "模型允许模式必须与最终允许模式一致");
  }
  if (handoff.handoffFingerprint !== computeHandoffFingerprint(handoff)) {
    mismatch(["handoffFingerprint"], "handoffFingerprint 必须与交接包语义预映像一致");
  }
});

export type EventV1 = z.infer<typeof EventV1Schema>;
export type EventAppendixV1 = z.infer<typeof EventAppendixV1Schema>;
export type RedactedBirthRecordV1 = z.infer<typeof RedactedBirthRecordV1Schema>;
export type HandoffPackageV1 = z.infer<typeof HandoffPackageV1Schema>;
