import { createHash } from "node:crypto";

import { LocalDateTime, OffsetDateTime } from "@js-joda/core";
import { canonicalize } from "json-canonicalize";
import { z } from "zod";

import {
  BirthRecordV1Schema,
  TimeEvidenceV1Schema,
  type BirthRecordV1
} from "../../shared/contracts.js";
import {
  ProvidedTimeBasisV1Schema,
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema,
  type PublicBirthRecordV2,
  type TimeEvidenceV2
} from "../../shared/provided-time-contracts.js";
import { PROVIDED_TIME_PRESENTATION } from "../../shared/provided-time-presentation.js";
import { classifyUnknownBirthplaceBasis } from "../../shared/unknown-birthplace.js";
import { calculateCandidateCharts } from "../charts/index.js";
import { BaziDetailV1Schema, type BaziDetailV1 } from "../charts/bazi-detail-contract.js";
import { parseBoundBaziDetail } from "../charts/bazi-detail-fingerprints.js";
import type { DualTrackChartSetV1 } from "../charts/types.js";
import {
  AUDIT_RULE_V2_SHA256,
  BAZI_DETAIL_RULE_V1_SHA256
} from "../rules/bazi-detail-manifest.js";
import {
  RULESET_SECTION_SHA256,
  XINJIANG_LOCATION_RULE_EVIDENCE
} from "../rules/ruleset-manifest.js";
import { UNKNOWN_BIRTHPLACE_RULE_EVIDENCE } from "../rules/unknown-birthplace-manifest.js";
import { normalizeBirthTime } from "../time/normalize-birth-time.js";
import { normalizeProvidedTime } from "../time/normalize-provided-time.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import { PROVIDED_TIME_RULE_EVIDENCE } from "../rules/provided-time-manifest.js";
import {
  AuditableChartBundleV1Schema,
  BaziChartAuditSchema,
  DualTrackChartSetAuditSchema,
  ZiweiChartAuditSchema,
  isTrackFailure,
  type AuditableChartBundleV1,
  type BaziChartAudit,
  type DualTrackChartSetAudit,
  type ZiweiChartAudit
} from "./chart-schemas.js";

export {
  AuditableChartBundleV1Schema,
  BaziChartAuditSchema,
  DualTrackChartSetAuditSchema,
  ZiweiChartAuditSchema
} from "./chart-schemas.js";
export type { AuditableChartBundleV1 } from "./chart-schemas.js";

export type AuditLevelV1 = "A" | "B" | "C" | "D";
export type AuditSeverityV1 = "info" | "warning" | "blocking";
export const AUDIT_CONTRACT_VERSION_V1 = "CyberSaga-Audit-Contract-v1" as const;
export const AUDIT_CONTRACT_VERSION_V2 = "CyberSaga-Audit-Contract-v2" as const;
export const AUDIT_CONTRACT_VERSION_V3 = "CyberSaga-Audit-Contract-v3" as const;
export const AUDIT_CONTRACT_VERSION_V4 = "CyberSaga-Audit-Contract-v4" as const;
export const AUDIT_CONTRACT_VERSION = AUDIT_CONTRACT_VERSION_V3;
export type AuditContractVersion =
  | typeof AUDIT_CONTRACT_VERSION_V1
  | typeof AUDIT_CONTRACT_VERSION_V2
  | typeof AUDIT_CONTRACT_VERSION_V3
  | typeof AUDIT_CONTRACT_VERSION_V4;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema)
]));

const TIMEZONE_ENGINE_SCHEMA = z.object({
  corePackage: z.string().min(1),
  coreVersion: z.string().min(1),
  timezonePackage: z.string().min(1),
  timezoneVersion: z.string().min(1),
  tzdbVersion: z.string().min(1),
  buildFile: z.string().min(1),
  buildSha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const AuditTimeIssueV1Schema = z.object({
  code: z.string().min(1),
  severity: z.enum(["warning", "blocking"]),
  message: z.string().min(1),
  candidateIds: z.array(z.string().min(1)).min(1)
}).strict();

const AuditTimeEvidenceV1Schema = z.object({
  ...TimeEvidenceV1Schema.shape,
  issues: z.array(AuditTimeIssueV1Schema)
}).strict();

const NoManualDecisionV1Schema = z.object({
  status: z.literal("none"),
  selectedCandidateId: z.null(),
  rationale: z.null(),
  decidedAt: z.null(),
  decidedBy: z.null(),
  evidenceRefs: z.tuple([])
}).strict();

const SHA256_REFERENCE = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ARTIFACT_REFERENCE = /^artifact:[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/u;

function isSafeArtifactReference(value: string): boolean {
  if (!SAFE_ARTIFACT_REFERENCE.test(value)) return false;
  return value.slice("artifact:".length).split("/").every((segment) => segment !== "." && segment !== "..");
}

const MANUAL_EVIDENCE_REF_SCHEMA = z.string().refine(
  (value) => SHA256_REFERENCE.test(value) || isSafeArtifactReference(value),
  "人工证据引用必须是案例内安全 artifact ID 或 sha256"
);

function normalizeRfc3339(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  try {
    return OffsetDateTime.parse(value).toInstant().toString();
  } catch {
    return null;
  }
}

const RFC3339_INSTANT_SCHEMA = z.string().transform((value, context) => {
  const normalized = normalizeRfc3339(value);
  if (normalized === null) {
    context.addIssue({ code: "custom", message: "decidedAt 必须是合法 RFC3339 时刻" });
    return z.NEVER;
  }
  return normalized;
});

const SelectedManualDecisionV1Schema = z.object({
  status: z.literal("selected"),
  selectedCandidateId: z.string().min(1),
  rationale: z.string().trim().min(8),
  decidedAt: RFC3339_INSTANT_SCHEMA,
  decidedBy: z.literal("local_operator"),
  evidenceRefs: z.array(MANUAL_EVIDENCE_REF_SCHEMA)
}).strict();

function nonSelectingDecisionSchema<T extends "deferred" | "retained_all" | "voided">(status: T) {
  return z.object({
    status: z.literal(status),
    selectedCandidateId: z.null(),
    rationale: z.string().trim().min(8),
    decidedAt: RFC3339_INSTANT_SCHEMA,
    decidedBy: z.literal("local_operator"),
    evidenceRefs: z.array(MANUAL_EVIDENCE_REF_SCHEMA)
  }).strict();
}

const DeferredManualDecisionV1Schema = nonSelectingDecisionSchema("deferred");
const RetainedAllManualDecisionV1Schema = nonSelectingDecisionSchema("retained_all");
const VoidedManualDecisionV1Schema = nonSelectingDecisionSchema("voided");

export const ManualDecisionV1Schema = z.discriminatedUnion("status", [
  NoManualDecisionV1Schema,
  DeferredManualDecisionV1Schema,
  RetainedAllManualDecisionV1Schema,
  SelectedManualDecisionV1Schema,
  VoidedManualDecisionV1Schema
]);

export type ManualDecisionV1 = z.infer<typeof ManualDecisionV1Schema>;

const CoverageSampleV1Schema = z.object({
  sampleId: z.string().min(1),
  candidateId: z.string().min(1),
  localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  calendarKey: z.string().min(1).optional()
}).strict();

export const CoverageProofV1Schema = z.object({
  rulesetVersion: z.literal("CyberSaga-Coverage-v1"),
  sourceRecordFingerprint: z.string().regex(SHA256_REFERENCE),
  artifactId: z.string().refine(isSafeArtifactReference),
  artifactSha256: z.string().regex(SHA256_REFERENCE),
  interval: z.object({
    startLocalDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
    endLocalDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
  }).strict(),
  samples: z.array(CoverageSampleV1Schema).min(2)
}).strict();

export const PrecisionCoverageV1Schema = z.object({
  mode: z.enum(["point", "interval", "branch"]),
  complete: z.boolean(),
  candidateIds: z.array(z.string().min(1)),
  note: z.string().trim().min(1).nullable(),
  proof: CoverageProofV1Schema.nullable().optional().default(null)
}).strict();

export const UncertaintyCoverageProofV1Schema = z.object({
  kind: z.enum(["representative_coordinate", "leap_month"]),
  rulesetVersion: z.literal("CyberSaga-Coverage-v1"),
  sourceRecordFingerprint: z.string().regex(SHA256_REFERENCE),
  artifactId: z.string().refine(isSafeArtifactReference),
  artifactSha256: z.string().regex(SHA256_REFERENCE),
  samples: z.array(CoverageSampleV1Schema).min(2)
}).strict();

export const ArtifactManifestV1Schema = z.object({
  artifacts: z.array(z.object({
    artifactId: z.string().refine(isSafeArtifactReference),
    sha256: z.string().regex(SHA256_REFERENCE)
  }).strict())
}).strict().superRefine((manifest, context) => {
  const artifactIds = manifest.artifacts.map((artifact) => artifact.artifactId);
  if (new Set(artifactIds).size !== artifactIds.length) {
    context.addIssue({
      code: "custom",
      message: "ARTIFACT_MANIFEST_ID_DUPLICATE",
      path: ["artifacts"]
    });
  }
});

const RULE_SNAPSHOT_HASHES = RULESET_SECTION_SHA256;
const LEGACY_RULE_SNAPSHOT_HASHES = Object.freeze({
  audit: RULESET_SECTION_SHA256.audit,
  time: RULESET_SECTION_SHA256.time,
  bazi: RULESET_SECTION_SHA256.bazi,
  ziwei: RULESET_SECTION_SHA256.ziwei
});

const XinjiangLocationRuleEvidenceV1Schema = z.object({
  ruleId: z.string().min(1),
  rulesetVersion: z.string().min(1),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const RuleSnapshotSha256V1Schema = z.object({
  audit: z.string().regex(/^[0-9a-f]{64}$/u),
  time: z.string().regex(/^[0-9a-f]{64}$/u),
  bazi: z.string().regex(/^[0-9a-f]{64}$/u),
  ziwei: z.string().regex(/^[0-9a-f]{64}$/u),
  xinjiangLocation: z.string().regex(/^[0-9a-f]{64}$/u).optional()
}).strict();

const VersionEvidenceCommonShape = {
  auditRuleset: z.string().min(1),
  timeRuleset: z.string().min(1),
  baziRuleset: z.string().min(1),
  ziweiRuleset: z.string().min(1),
  lunarEngine: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  ziweiEngine: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
  timezoneEngine: TIMEZONE_ENGINE_SCHEMA,
  xinjiangLocationRule: XinjiangLocationRuleEvidenceV1Schema.optional(),
  unknownBirthplaceRule: XinjiangLocationRuleEvidenceV1Schema.optional()
};

const AuditedVersionEvidenceV1Schema = z.object({
  ...VersionEvidenceCommonShape,
  ruleSnapshotSha256: RuleSnapshotSha256V1Schema.optional()
}).strict();

export const VersionEvidenceV1Schema = z.object({
  ...VersionEvidenceCommonShape,
  ruleSnapshotSha256: RuleSnapshotSha256V1Schema.optional().default(LEGACY_RULE_SNAPSHOT_HASHES)
}).strict();

export type VersionEvidenceV1 = z.infer<typeof VersionEvidenceV1Schema>;
type AuditedVersionEvidenceV1 = z.infer<typeof AuditedVersionEvidenceV1Schema>;

const ProvidedTimeRuleEvidenceV1Schema = z.object({
  ruleId: z.literal("provided-final-local-time"),
  rulesetVersion: z.literal("CyberSaga-Provided-Time-v1"),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const LockedLunarEngineSchema = z.object({
  name: z.literal("lunar-typescript"),
  version: z.literal("1.8.6")
}).strict();
const LockedZiweiEngineSchema = z.object({
  name: z.literal("iztro"),
  version: z.literal("2.5.8")
}).strict();

export const VersionEvidenceV2Schema = z.object({
  auditRuleset: z.literal("CyberSaga-Audit-v1"),
  timeRuleset: z.literal("CyberSaga-Provided-Time-v1"),
  baziRuleset: z.literal("CyberSaga-Bazi-v1"),
  ziweiRuleset: z.literal("CyberSaga-Ziwei-v1"),
  timeInputBasis: ProvidedTimeBasisV1Schema,
  providedTimeRule: ProvidedTimeRuleEvidenceV1Schema,
  lunarEngine: z.object({
    name: z.literal("lunar-typescript"),
    version: z.literal("1.8.6")
  }).strict(),
  ziweiEngine: z.object({
    name: z.literal("iztro"),
    version: z.literal("2.5.8")
  }).strict(),
  timezoneEngine: z.never().optional(),
  xinjiangLocationRule: z.never().optional(),
  unknownBirthplaceRule: z.never().optional(),
  ruleSnapshotSha256: z.object({
    audit: z.string().regex(/^[0-9a-f]{64}$/u),
    bazi: z.string().regex(/^[0-9a-f]{64}$/u),
    ziwei: z.string().regex(/^[0-9a-f]{64}$/u),
    providedTime: z.string().regex(/^[0-9a-f]{64}$/u)
  }).strict()
}).strict();

export type VersionEvidenceV2 = z.infer<typeof VersionEvidenceV2Schema>;

export const VersionEvidenceV3Schema = z.object({
  auditRuleset: z.literal("CyberSaga-Audit-v2"),
  timeRuleset: z.literal("CyberSaga-Provided-Time-v1"),
  baziRuleset: z.literal("CyberSaga-Bazi-v1"),
  baziDetailRuleset: z.literal("CyberSaga-Bazi-Detail-v1"),
  ziweiRuleset: z.literal("CyberSaga-Ziwei-v1"),
  timeInputBasis: ProvidedTimeBasisV1Schema,
  providedTimeRule: ProvidedTimeRuleEvidenceV1Schema,
  lunarEngine: LockedLunarEngineSchema,
  baziDetailEngine: LockedLunarEngineSchema,
  ziweiEngine: LockedZiweiEngineSchema,
  ruleSnapshotSha256: z.object({
    audit: DigestSchema,
    bazi: DigestSchema,
    baziDetail: DigestSchema,
    ziwei: DigestSchema,
    providedTime: DigestSchema
  }).strict()
}).strict();

export type VersionEvidenceV3 = z.infer<typeof VersionEvidenceV3Schema>;

const AuditCommonShape = {
  auditReportId: z.string().min(1),
  revisionId: z.string().regex(/^R\d{3}$/u),
  birthRecord: BirthRecordV1Schema,
  timeEvidence: AuditTimeEvidenceV1Schema,
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  manualDecision: ManualDecisionV1Schema,
  provenanceFlags: z.array(z.string().min(1)),
  precisionCoverage: PrecisionCoverageV1Schema,
  uncertaintyProofs: z.array(UncertaintyCoverageProofV1Schema).optional().default([]),
  artifactManifest: ArtifactManifestV1Schema.optional().default({ artifacts: [] }),
  storedContentFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional()
};

const ModernAuditInputV1Schema = z.object({
  ...AuditCommonShape,
  chartSet: DualTrackChartSetAuditSchema,
  versionEvidence: AuditedVersionEvidenceV1Schema.optional()
}).strict();

const LegacyAuditInputV1Schema = z.object({
  ...AuditCommonShape,
  chartBundles: z.array(AuditableChartBundleV1Schema),
  versionEvidence: VersionEvidenceV1Schema
}).strict();

export const AuditInputV1Schema = z.union([
  ModernAuditInputV1Schema,
  LegacyAuditInputV1Schema
]).superRefine((input, context) => {
  const candidateIds = new Set(input.timeEvidence.candidates.map((candidate) => candidate.id));
  const uncertaintyKinds = input.uncertaintyProofs.map((proof) => proof.kind);
  if (new Set(uncertaintyKinds).size !== uncertaintyKinds.length) {
    context.addIssue({
      code: "custom",
      message: "UNCERTAINTY_PROOF_KIND_DUPLICATE",
      path: ["uncertaintyProofs"]
    });
  }
  if (input.manualDecision.status === "selected" && !candidateIds.has(input.manualDecision.selectedCandidateId)) {
    context.addIssue({
      code: "custom",
      message: "MANUAL_DECISION_CANDIDATE_INVALID",
      path: ["manualDecision", "selectedCandidateId"]
    });
  }
  if (input.manualDecision.status === "voided" && input.workflowStatus !== "void") {
    context.addIssue({
      code: "custom",
      message: "VOID_DECISION_REQUIRES_VOID_WORKFLOW",
      path: ["manualDecision", "status"]
    });
  }

  const expectedCoverageMode = input.birthRecord.birthTime.precision === "minute"
    ? "point"
    : input.birthRecord.birthTime.precision === "approximate"
      ? "interval"
      : "branch";
  if (input.precisionCoverage.mode !== expectedCoverageMode) {
    context.addIssue({
      code: "custom",
      message: "PRECISION_COVERAGE_MODE_INVALID",
      path: ["precisionCoverage", "mode"]
    });
  }
  const coverageIds = new Set(input.precisionCoverage.candidateIds);
  if (
    coverageIds.size !== input.precisionCoverage.candidateIds.length
    || [...coverageIds].some((candidateId) => !candidateIds.has(candidateId))
    || (
      input.precisionCoverage.complete
      && (coverageIds.size !== candidateIds.size || [...candidateIds].some((candidateId) => !coverageIds.has(candidateId)))
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "PRECISION_COVERAGE_INCOMPLETE",
      path: ["precisionCoverage", "candidateIds"]
    });
  }
  if (
    (input.precisionCoverage.complete && input.precisionCoverage.note !== null)
    || (!input.precisionCoverage.complete && input.precisionCoverage.note === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "PRECISION_COVERAGE_NOTE_INVALID",
      path: ["precisionCoverage", "note"]
    });
  }

  const manifest = new Map(input.artifactManifest.artifacts.map((artifact) => [artifact.artifactId, artifact.sha256]));
  const artifactReferences = input.manualDecision.evidenceRefs.filter((reference) => reference.startsWith("artifact:"));
  for (const reference of artifactReferences) {
    if (!manifest.has(reference)) {
      context.addIssue({
        code: "custom",
        message: "MANUAL_EVIDENCE_REF_NOT_IN_MANIFEST",
        path: ["manualDecision", "evidenceRefs"]
      });
    }
  }
  const coverageProofs = [
    ...(input.precisionCoverage.proof === null ? [] : [input.precisionCoverage.proof]),
    ...input.uncertaintyProofs
  ];
  for (const proof of coverageProofs) {
    if (manifest.get(proof.artifactId) !== proof.artifactSha256) {
      context.addIssue({
        code: "custom",
        message: "COVERAGE_PROOF_NOT_IN_MANIFEST",
        path: ["artifactManifest"]
      });
    }
  }
});

export type AuditInputV1 = z.input<typeof LegacyAuditInputV1Schema>;
export type ModernAuditInputV1 = z.input<typeof ModernAuditInputV1Schema>;
type ParsedAuditInputV1 = z.output<typeof AuditInputV1Schema>;
type ParsedModernAuditInputV1 = z.output<typeof ModernAuditInputV1Schema>;
type ParsedAuditInputV2 = z.output<typeof AuditInputV2Schema>;
type NormalizedAuditInputV1 = Omit<ParsedModernAuditInputV1, "chartSet" | "versionEvidence"> & {
  chartSet: DualTrackChartSetAudit;
  chartBundles: AuditableChartBundleV1[];
  versionEvidence: AuditedVersionEvidenceV1 | null;
  inputKind: "chart_set" | "legacy_bundles";
};

export const AuditInputV2Schema = z.object({
  auditReportId: z.string().min(1),
  revisionId: z.string().regex(/^R\d{3}$/u),
  birthRecord: PublicBirthRecordV2Schema,
  timeEvidence: TimeEvidenceV2Schema,
  chartSet: DualTrackChartSetAuditSchema,
  versionEvidence: VersionEvidenceV2Schema,
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  manualDecision: ManualDecisionV1Schema,
  provenanceFlags: z.array(z.string().min(1)),
  privateMetadataPresence: z.object({
    providedTimeSourceNote: z.boolean()
  }).strict().optional().default({ providedTimeSourceNote: false }),
  precisionCoverage: PrecisionCoverageV1Schema,
  artifactManifest: ArtifactManifestV1Schema.optional().default({ artifacts: [] }),
  storedContentFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional()
}).strict().superRefine((input, context) => {
  const candidateIds = new Set(input.timeEvidence.candidates.map((candidate) => candidate.id));
  if (input.birthRecord.caseId !== input.timeEvidence.caseId || input.chartSet.caseId !== input.birthRecord.caseId) {
    context.addIssue({ code: "custom", message: "V2 案例身份不一致", path: ["caseId"] });
  }
  if (input.chartSet.timeRulesetVersion !== input.timeEvidence.rulesetVersion) {
    context.addIssue({ code: "custom", message: "V2 时间规则身份不一致", path: ["chartSet", "timeRulesetVersion"] });
  }
  if (input.manualDecision.status === "selected" && !candidateIds.has(input.manualDecision.selectedCandidateId)) {
    context.addIssue({ code: "custom", message: "MANUAL_DECISION_CANDIDATE_INVALID", path: ["manualDecision", "selectedCandidateId"] });
  }
  if (input.manualDecision.status === "voided" && input.workflowStatus !== "void") {
    context.addIssue({ code: "custom", message: "VOID_DECISION_REQUIRES_VOID_WORKFLOW", path: ["manualDecision", "status"] });
  }
  const expectedCoverageMode = input.birthRecord.providedTime.precision === "minute"
    ? "point"
    : input.birthRecord.providedTime.precision === "approximate"
      ? "interval"
      : "branch";
  if (input.precisionCoverage.mode !== expectedCoverageMode) {
    context.addIssue({ code: "custom", message: "PRECISION_COVERAGE_MODE_INVALID", path: ["precisionCoverage", "mode"] });
  }
  const coverageIds = new Set(input.precisionCoverage.candidateIds);
  if (
    coverageIds.size !== input.precisionCoverage.candidateIds.length
    || [...coverageIds].some((candidateId) => !candidateIds.has(candidateId))
    || (
      input.precisionCoverage.complete
      && (coverageIds.size !== candidateIds.size || [...candidateIds].some((candidateId) => !coverageIds.has(candidateId)))
    )
  ) {
    context.addIssue({ code: "custom", message: "PRECISION_COVERAGE_INCOMPLETE", path: ["precisionCoverage", "candidateIds"] });
  }
  if (
    (input.precisionCoverage.complete && input.precisionCoverage.note !== null)
    || (!input.precisionCoverage.complete && input.precisionCoverage.note === null)
  ) {
    context.addIssue({ code: "custom", message: "PRECISION_COVERAGE_NOTE_INVALID", path: ["precisionCoverage", "note"] });
  }
});

export type AuditInputV2 = z.input<typeof AuditInputV2Schema>;

const FINDING_CODES = [
  "ARTIFACT_CONTENT_MISMATCH",
  "ARTIFACT_SCHEMA_INVALID",
  "CALENDAR_BASIS_CONFLICT",
  "CANDIDATES_SAME_DUAL_CHART",
  "CANDIDATE_CHART_INCOMPLETE",
  "CANDIDATE_DIVERGENCE_MANUALLY_SELECTED",
  "CANDIDATE_DIVERGENCE_UNRESOLVED",
  "CANDIDATE_REFERENCE_INVALID",
  "CASE_REVISION_OR_CANDIDATE_MISMATCH",
  "CHART_ENGINE_REPLAY_MISMATCH",
  "CLOCK_CONVENTION_UNRESOLVED",
  "CONTENT_FINGERPRINT_MISMATCH",
  "DUAL_TRACK_SOURCE_MISMATCH",
  "ENGINE_PARTIAL_FAILURE",
  "ENGINE_TOTAL_FAILURE",
  "ENGINE_VERSION_UNAPPROVED",
  "LEAP_MONTH_CANDIDATES_MATERIAL",
  "LEAP_MONTH_CANDIDATES_SAME_CHART",
  "LEAP_MONTH_EVIDENCE_INCOMPLETE",
  "LOCATION_CONFLICT",
  "LOCATION_COORDINATE_UNKNOWN",
  "NO_COMPLETE_DUAL_CHART",
  "PRECISION_APPROXIMATE_SAME_CHART",
  "PRECISION_APPROXIMATE_UNRESOLVED",
  "PRECISION_BRANCH_SAME_CHART",
  "PRECISION_BRANCH_UNRESOLVED",
  "PRECISION_MINUTE",
  "PRECISION_MINUTE_UNRESOLVED",
  "REPRESENTATIVE_COORDINATE_MATERIAL",
  "REPRESENTATIVE_COORDINATE_SAME_CHART",
  "REQUIRED_CHART_FIELD_MISSING",
  "RULESET_VERSION_UNAPPROVED",
  "SELECTED_CANDIDATE_INCOMPLETE",
  "SOURCE_CONFLICT",
  "SOURCE_EXPLICIT_GUESS",
  "SOURCE_EXISTING_CHART_ONLY",
  "SOURCE_FAMILY_MEMORY",
  "SOURCE_RECORD_FINGERPRINT_MISMATCH",
  "SOURCE_PRIMARY_DOCUMENTED",
  "SOURCE_UNKNOWN",
  "TIME_DST_GAP",
  "TIME_DST_OVERLAP_MATERIAL",
  "TIME_DST_OVERLAP_SAME_CHART",
  "TIME_DST_UNKNOWN_MATERIAL",
  "TIME_DST_UNKNOWN_SAME_CHART",
  "TIME_EVIDENCE_INCOMPLETE",
  "TIME_EVIDENCE_REPLAY_MISMATCH",
  "TIME_FUTURE_PROVISIONAL",
  "TIME_HISTORICAL_UNCERTAINTY",
  "TIME_ISSUE_SEVERITY_INVALID",
  "TIME_LATE_ZI_MATERIAL",
  "TIME_LATE_ZI_SAME_CHART",
  "TIME_LEAP_MONTH_ALTERNATIVE_INVALID",
  "TIME_LEAP_MONTH_UNRESOLVED",
  "TIME_STANDARD_OFFSET_UNRESOLVED",
  "TIME_TRUE_SOLAR_BRANCH_CHANGE",
  "TIME_TRUE_SOLAR_MATERIAL",
  "TIME_TRUE_SOLAR_SAME_CHART",
  "TIMEZONE_MANIFEST_MISMATCH",
  "UNKNOWN_PROVENANCE_FLAG",
  "UNKNOWN_TIME_ISSUE_CODE",
  "XINJIANG_CLOCK_CONVENTION_UNRESOLVED"
] as const;

export type AuditFindingCodeV1 = typeof FINDING_CODES[number];

interface FindingDefinition {
  severity: AuditSeverityV1;
  levelImpact: AuditLevelV1;
  summary: string;
}

const FINDING_REGISTRY: Record<AuditFindingCodeV1, FindingDefinition> = {
  ARTIFACT_CONTENT_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "案例清单中的内容哈希与待审计产物不一致"
  },
  ARTIFACT_SCHEMA_INVALID: {
    severity: "blocking",
    levelImpact: "D",
    summary: "待审计产物不符合锁定的 V1 数据契约"
  },
  CALENDAR_BASIS_CONFLICT: {
    severity: "blocking",
    levelImpact: "D",
    summary: "公历与农历资料口径冲突且没有完整候选证据"
  },
  CANDIDATES_SAME_DUAL_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "存在多个时间候选，但完整八字与紫微盘实质相同"
  },
  CANDIDATE_CHART_INCOMPLETE: {
    severity: "blocking",
    levelImpact: "C",
    summary: "部分时间候选尚无完整双轨排盘"
  },
  CANDIDATE_DIVERGENCE_MANUALLY_SELECTED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "候选盘存在实质差异；人工选择不消除当前修订的不确定性"
  },
  CANDIDATE_DIVERGENCE_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "候选盘存在实质差异且尚未解决"
  },
  CANDIDATE_REFERENCE_INVALID: {
    severity: "blocking",
    levelImpact: "D",
    summary: "审计证据引用了不存在的时间候选"
  },
  CASE_REVISION_OR_CANDIDATE_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "案例、修订或候选集合在证据产物之间不一致"
  },
  CHART_ENGINE_REPLAY_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "保存的盘面与锁定引擎对同一输入的重算结果不一致"
  },
  CLOCK_CONVENTION_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "出生记录采用的钟表时制尚未确认"
  },
  CONTENT_FINGERPRINT_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "存储的内容指纹与当前规范内容不一致"
  },
  DUAL_TRACK_SOURCE_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "八字与紫微不是由同一候选输入生成"
  },
  ENGINE_PARTIAL_FAILURE: {
    severity: "blocking",
    levelImpact: "C",
    summary: "部分候选的八字或紫微引擎计算失败"
  },
  ENGINE_TOTAL_FAILURE: {
    severity: "blocking",
    levelImpact: "D",
    summary: "所有候选都缺少可用的完整双轨引擎结果"
  },
  ENGINE_VERSION_UNAPPROVED: {
    severity: "blocking",
    levelImpact: "D",
    summary: "排盘引擎名称或版本不在 V1 批准清单"
  },
  LEAP_MONTH_CANDIDATES_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "闰月口径候选覆盖完整，但候选盘存在实质差异"
  },
  LEAP_MONTH_CANDIDATES_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "闰月口径候选覆盖完整，且完整双轨盘实质相同"
  },
  LEAP_MONTH_EVIDENCE_INCOMPLETE: {
    severity: "blocking",
    levelImpact: "D",
    summary: "闰月口径未确认且候选证据覆盖不完整"
  },
  LOCATION_CONFLICT: {
    severity: "blocking",
    levelImpact: "D",
    summary: "出生地资料互相冲突"
  },
  LOCATION_COORDINATE_UNKNOWN: {
    severity: "blocking",
    levelImpact: "D",
    summary: "出生地坐标未知；当前仅按北京时间口径暂算，未计算真太阳时"
  },
  NO_COMPLETE_DUAL_CHART: {
    severity: "blocking",
    levelImpact: "D",
    summary: "当前修订不存在任何完整双轨候选盘"
  },
  PRECISION_APPROXIMATE_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "约略出生时间的覆盖完整，且所有候选双轨盘实质相同"
  },
  PRECISION_APPROXIMATE_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "约略出生时间尚未完整覆盖，或覆盖候选存在实质差异"
  },
  PRECISION_BRANCH_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "时辰区间的覆盖完整，且所有候选双轨盘实质相同"
  },
  PRECISION_BRANCH_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "时辰区间尚未完整覆盖，或覆盖候选存在实质差异"
  },
  PRECISION_MINUTE: {
    severity: "info",
    levelImpact: "A",
    summary: "出生时间精度为分钟"
  },
  PRECISION_MINUTE_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "分钟级出生时间仍有候选尚未完整计算"
  },
  REPRESENTATIVE_COORDINATE_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "城市代表点与经度候选导致实质不同的候选盘"
  },
  REPRESENTATIVE_COORDINATE_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "使用城市代表点坐标，但已证明完整候选盘实质相同"
  },
  REQUIRED_CHART_FIELD_MISSING: {
    severity: "blocking",
    levelImpact: "D",
    summary: "所有候选都缺少 V1 要求的确定性盘面字段"
  },
  RULESET_VERSION_UNAPPROVED: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时间或排盘规则集版本不在 V1 批准清单"
  },
  SELECTED_CANDIDATE_INCOMPLETE: {
    severity: "blocking",
    levelImpact: "D",
    summary: "人工选择的候选没有完整双轨排盘"
  },
  SOURCE_CONFLICT: {
    severity: "blocking",
    levelImpact: "D",
    summary: "出生资料来源互相冲突"
  },
  SOURCE_EXPLICIT_GUESS: {
    severity: "blocking",
    levelImpact: "D",
    summary: "出生时间被明确标记为猜测"
  },
  SOURCE_EXISTING_CHART_ONLY: {
    severity: "blocking",
    levelImpact: "C",
    summary: "出生时间仅来自既有排盘，缺少独立原始资料"
  },
  SOURCE_FAMILY_MEMORY: {
    severity: "warning",
    levelImpact: "B",
    summary: "出生时间来自家人记忆，保留来源不确定性"
  },
  SOURCE_RECORD_FINGERPRINT_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时间证据的来源指纹不属于当前 BirthRecord 公开修订"
  },
  SOURCE_PRIMARY_DOCUMENTED: {
    severity: "info",
    levelImpact: "A",
    summary: "出生时间来自出生证明或医院记录"
  },
  SOURCE_UNKNOWN: {
    severity: "blocking",
    levelImpact: "D",
    summary: "出生时间资料来源不明"
  },
  TIME_DST_GAP: {
    severity: "blocking",
    levelImpact: "C",
    summary: "出生钟面时间落入夏令时跳时空档，纠偏候选仍需核验"
  },
  TIME_DST_OVERLAP_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "夏令时重复时间产生实质不同的候选盘"
  },
  TIME_DST_OVERLAP_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "夏令时重复时间候选保留，且完整双轨盘实质相同"
  },
  TIME_DST_UNKNOWN_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "夏令时采用口径未知且候选盘存在实质差异"
  },
  TIME_DST_UNKNOWN_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "夏令时采用口径未知，但完整候选盘实质相同"
  },
  TIME_EVIDENCE_INCOMPLETE: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时间问题声明的必要候选证据不完整"
  },
  TIME_EVIDENCE_REPLAY_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "重放锁定时间引擎时发现候选、问题或换算步骤被删减或改写"
  },
  TIME_FUTURE_PROVISIONAL: {
    severity: "warning",
    levelImpact: "B",
    summary: "出生时间超出当前时区数据发布期，结果为暂定"
  },
  TIME_HISTORICAL_UNCERTAINTY: {
    severity: "warning",
    levelImpact: "B",
    summary: "1970 年以前的历史时区结果带有不确定性"
  },
  TIME_ISSUE_SEVERITY_INVALID: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时间问题严重度与锁定规则注册表不一致"
  },
  TIME_LATE_ZI_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "晚子时换日口径产生实质不同的候选盘"
  },
  TIME_LATE_ZI_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "晚子时换日候选保留，且完整候选盘实质相同"
  },
  TIME_LEAP_MONTH_ALTERNATIVE_INVALID: {
    severity: "blocking",
    levelImpact: "D",
    summary: "闰月状态未确认且一侧口径无有效日期；转换失败证据已保留"
  },
  TIME_LEAP_MONTH_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "闰月口径尚未裁决，普通月与闰月候选均保留"
  },
  TIME_STANDARD_OFFSET_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "C",
    summary: "标准时偏移尚无可靠证据，相关时间口径不能自动裁决"
  },
  TIME_TRUE_SOLAR_BRANCH_CHANGE: {
    severity: "blocking",
    levelImpact: "C",
    summary: "真太阳时校正改变时支，必须保留候选复核"
  },
  TIME_TRUE_SOLAR_MATERIAL: {
    severity: "blocking",
    levelImpact: "C",
    summary: "真太阳时虽未改变时支标签，但候选盘仍有实质差异"
  },
  TIME_TRUE_SOLAR_SAME_CHART: {
    severity: "warning",
    levelImpact: "B",
    summary: "真太阳时校正未改变完整候选盘"
  },
  TIMEZONE_MANIFEST_MISMATCH: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时区依赖、tzdb 或构建文件指纹与批准清单不一致"
  },
  UNKNOWN_PROVENANCE_FLAG: {
    severity: "blocking",
    levelImpact: "D",
    summary: "资料来源层返回了审计规则集未注册的标记"
  },
  UNKNOWN_TIME_ISSUE_CODE: {
    severity: "blocking",
    levelImpact: "D",
    summary: "时间引擎返回了审计规则集未注册的问题代码"
  },
  XINJIANG_CLOCK_CONVENTION_UNRESOLVED: {
    severity: "blocking",
    levelImpact: "D",
    summary: "新疆案例尚未确认使用北京时间还是新疆时间"
  }
};

export const AuditFindingV1Schema = z.object({
  code: z.enum(FINDING_CODES),
  severity: z.enum(["info", "warning", "blocking"]),
  levelImpact: z.enum(["A", "B", "C", "D"]),
  summary: z.string().min(1),
  candidateIds: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1))
}).strict();

export const BlockingReasonV1Schema = z.object({
  code: z.union([z.enum(FINDING_CODES), z.literal("WORKFLOW_VOID")]),
  source: z.enum(["audit", "workflow"]),
  levelImpact: z.enum(["C", "D"]).nullable(),
  candidateIds: z.array(z.string().min(1)),
  summary: z.string().min(1)
}).strict();

export const ContentFingerprintV1Schema = z.object({
  algorithm: z.literal("sha256"),
  canonicalization: z.literal("json-canonicalize@2.0.0"),
  scope: z.enum([
    "birth-time-charts-rules-manual-v1",
    "provided-time-charts-rules-manual-v1"
  ]),
  value: z.string().regex(/^[0-9a-f]{64}$/u)
}).strict();

export const ContentFingerprintV2Schema = z.object({
  algorithm: z.literal("sha256"),
  canonicalization: z.literal("json-canonicalize@2.0.0"),
  scope: z.literal("provided-time-charts-bazi-detail-rules-manual-v1"),
  value: DigestSchema
}).strict();

export type ContentFingerprintV2 = z.infer<typeof ContentFingerprintV2Schema>;

const VERSION_EVIDENCE_BLOCKER_CODES = [
  "ENGINE_VERSION_UNAPPROVED",
  "RULESET_VERSION_UNAPPROVED",
  "TIMEZONE_MANIFEST_MISMATCH"
] as const;

export type AuditVersionEvidenceBlockerCodeV1 = typeof VERSION_EVIDENCE_BLOCKER_CODES[number];

export interface AuditVersionEvidenceAssessment {
  status: "approved" | "missing" | "invalid" | "unapproved";
  approved: boolean;
  requiredBlockerCodes: AuditVersionEvidenceBlockerCodeV1[];
}

export function assessAuditVersionEvidence(value: unknown): AuditVersionEvidenceAssessment {
  if (value === null || value === undefined) {
    return {
      status: "missing",
      approved: false,
      requiredBlockerCodes: [...VERSION_EVIDENCE_BLOCKER_CODES]
    };
  }
  const provided = VersionEvidenceV2Schema.safeParse(value);
  if (provided.success) {
    const requiredBlockerCodes: AuditVersionEvidenceBlockerCodeV1[] = [];
    if (
      canonicalString(jsonValue(provided.data.lunarEngine))
        !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE_V2.lunarEngine))
      || canonicalString(jsonValue(provided.data.ziweiEngine))
        !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE_V2.ziweiEngine))
    ) {
      requiredBlockerCodes.push("ENGINE_VERSION_UNAPPROVED");
    }
    const { timeInputBasis: _actualBasis, ...actualRules } = provided.data;
    if (canonicalString(jsonValue(actualRules)) !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE_V2))) {
      requiredBlockerCodes.push("RULESET_VERSION_UNAPPROVED");
    }
    return requiredBlockerCodes.length === 0
      ? { status: "approved", approved: true, requiredBlockerCodes }
      : { status: "unapproved", approved: false, requiredBlockerCodes };
  }
  const parsed = AuditedVersionEvidenceV1Schema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "invalid",
      approved: false,
      requiredBlockerCodes: [...VERSION_EVIDENCE_BLOCKER_CODES]
    };
  }

  const evidence = parsed.data;
  const requiredBlockerCodes: AuditVersionEvidenceBlockerCodeV1[] = [];
  if (
    canonicalString(jsonValue(evidence.lunarEngine))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.lunarEngine))
    || canonicalString(jsonValue(evidence.ziweiEngine))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiEngine))
  ) {
    requiredBlockerCodes.push("ENGINE_VERSION_UNAPPROVED");
  }
  if (
    evidence.auditRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.auditRuleset
    || evidence.timeRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.timeRuleset
    || evidence.baziRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.baziRuleset
    || evidence.ziweiRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiRuleset
    || canonicalString(jsonValue(evidence.xinjiangLocationRule ?? null))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.xinjiangLocationRule))
    || (
      evidence.unknownBirthplaceRule !== undefined
      && canonicalString(jsonValue(evidence.unknownBirthplaceRule))
        !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.unknownBirthplaceRule))
    )
    || canonicalString(jsonValue(evidence.ruleSnapshotSha256 ?? null))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.ruleSnapshotSha256))
  ) {
    requiredBlockerCodes.push("RULESET_VERSION_UNAPPROVED");
  }
  if (
    canonicalString(jsonValue(evidence.timezoneEngine))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.timezoneEngine))
  ) {
    requiredBlockerCodes.push("TIMEZONE_MANIFEST_MISMATCH");
  }

  return requiredBlockerCodes.length === 0
    ? { status: "approved", approved: true, requiredBlockerCodes }
    : { status: "unapproved", approved: false, requiredBlockerCodes };
}

export function assessAuditVersionEvidenceV3(value: unknown): AuditVersionEvidenceAssessment {
  const parsed = VersionEvidenceV3Schema.safeParse(value);
  if (!parsed.success) {
    return {
      status: "invalid",
      approved: false,
      requiredBlockerCodes: [...VERSION_EVIDENCE_BLOCKER_CODES]
    };
  }
  const { timeInputBasis: _timeInputBasis, ...actual } = parsed.data;
  if (canonicalString(jsonValue(actual)) !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE_V3))) {
    return {
      status: "unapproved",
      approved: false,
      requiredBlockerCodes: ["RULESET_VERSION_UNAPPROVED"]
    };
  }
  return { status: "approved", approved: true, requiredBlockerCodes: [] };
}

const AuditReportV1OuterSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  auditReportId: z.string().min(1),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  revisionId: z.string().regex(/^R\d{3}$/u),
  candidateIds: z.array(z.string().min(1)),
  rulesetVersion: z.literal("CyberSaga-Audit-v1"),
  engineVersions: z.union([AuditedVersionEvidenceV1Schema, VersionEvidenceV2Schema]).nullable(),
  provenanceFlags: z.array(z.string().min(1)).optional(),
  timeInputBoundary: z.object({
    basis: ProvidedTimeBasisV1Schema,
    assertionCode: z.enum(["provided_apparent_solar", "provided_civil_clock"])
  }).strict().optional(),
  auditLevel: z.enum(["A", "B", "C", "D"]),
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  findings: z.array(AuditFindingV1Schema),
  blockingReasons: z.array(BlockingReasonV1Schema),
  allowedAnalysisModes: z.array(z.enum([
    "full_dual",
    "provisional_dual",
    "single_track",
    "data_diagnosis"
  ])),
  manualDecision: ManualDecisionV1Schema,
  contentFingerprint: ContentFingerprintV1Schema
}).strict();

type AuditReportRefinementTarget = Omit<z.infer<typeof AuditReportV1OuterSchema>,
  "schemaVersion" | "rulesetVersion" | "engineVersions" | "contentFingerprint"> & {
  schemaVersion: string;
  rulesetVersion: string;
  engineVersions: unknown;
  contentFingerprint: {
    algorithm: "sha256";
    canonicalization: "json-canonicalize@2.0.0";
    scope: string;
    value: string;
  };
};

function refineAuditReport(
  report: AuditReportRefinementTarget,
  context: z.RefinementCtx,
  assessVersionEvidence: (value: unknown) => AuditVersionEvidenceAssessment
): void {
  const candidateIdSet = new Set(report.candidateIds);
  const versionEvidence = assessVersionEvidence(report.engineVersions);
  const versionBlockerCodes = new Set(report.blockingReasons.flatMap((reason) => (
    reason.source === "audit"
    && (VERSION_EVIDENCE_BLOCKER_CODES as readonly string[]).includes(reason.code)
      ? [reason.code as AuditVersionEvidenceBlockerCodeV1]
      : []
  )));
  const allowsNonDiagnosticMode = report.allowedAnalysisModes.some((mode) => mode !== "data_diagnosis");
  const requiresApprovedEvidence = report.auditLevel !== "D" || allowsNonDiagnosticMode;
  if (requiresApprovedEvidence && !versionEvidence.approved) {
    context.addIssue({
      code: "custom",
      message: "A/B/C 或允许非诊断模式的报告必须携带完整且获批的版本证据",
      path: ["engineVersions"]
    });
  }
  if (requiresApprovedEvidence && versionBlockerCodes.size > 0) {
    context.addIssue({
      code: "custom",
      message: "A/B/C 或允许非诊断模式的报告不得包含版本不批准阻断",
      path: ["blockingReasons"]
    });
  }
  if (!versionEvidence.approved) {
    if (report.auditLevel !== "D") {
      context.addIssue({
        code: "custom",
        message: "缺失、不完整或未获批版本证据的报告必须为 D 级",
        path: ["auditLevel"]
      });
    }
    versionEvidence.requiredBlockerCodes.forEach((requiredCode) => {
      if (!versionBlockerCodes.has(requiredCode)) {
        context.addIssue({
          code: "custom",
          message: `版本证据缺失、不完整或未获批的报告必须包含 ${requiredCode} 阻断`,
          path: ["blockingReasons"]
        });
      }
    });
    if (
      report.workflowStatus !== "void"
      && JSON.stringify(report.allowedAnalysisModes) !== JSON.stringify(["data_diagnosis"])
    ) {
      context.addIssue({
        code: "custom",
        message: "版本证据缺失、不完整或未获批的报告仅允许资料诊断",
        path: ["allowedAnalysisModes"]
      });
    }
  }
  if (report.candidateIds.length === 0 && report.auditLevel !== "D") {
    context.addIssue({ code: "custom", message: "只有 D 级诊断报告可以没有候选 ID", path: ["candidateIds"] });
  }
  if (candidateIdSet.size !== report.candidateIds.length) {
    context.addIssue({ code: "custom", message: "报告候选 ID 必须唯一", path: ["candidateIds"] });
  }
  if (JSON.stringify(report.candidateIds) !== JSON.stringify([...candidateIdSet].sort(compareText))) {
    context.addIssue({ code: "custom", message: "报告候选 ID 必须按规范顺序保存", path: ["candidateIds"] });
  }

  report.findings.forEach((finding, findingIndex) => {
    const definition = FINDING_REGISTRY[finding.code];
    if (
      finding.severity !== definition.severity
      || finding.levelImpact !== definition.levelImpact
      || finding.summary !== definition.summary
    ) {
      context.addIssue({
        code: "custom",
        message: "finding 必须与锁定注册表一致",
        path: ["findings", findingIndex]
      });
    }
    finding.candidateIds.forEach((candidateId, candidateIndex) => {
      if (!candidateIdSet.has(candidateId)) {
        context.addIssue({
          code: "custom",
          message: "finding 引用了不存在的候选",
          path: ["findings", findingIndex, "candidateIds", candidateIndex]
        });
      }
    });
    if (
      JSON.stringify(finding.candidateIds) !== JSON.stringify(sortedUnique(finding.candidateIds))
      || JSON.stringify(finding.evidenceRefs) !== JSON.stringify(sortedUnique(finding.evidenceRefs))
    ) {
      context.addIssue({
        code: "custom",
        message: "finding 内的候选与证据引用必须唯一且规范排序",
        path: ["findings", findingIndex]
      });
    }
  });
  if (new Set(report.findings.map((finding) => finding.code)).size !== report.findings.length) {
    context.addIssue({ code: "custom", message: "finding code 不得重复", path: ["findings"] });
  }

  const blockingFindings = report.findings.filter((finding) => finding.severity === "blocking");
  const localOrder: Record<AuditLevelV1, number> = { A: 0, B: 1, C: 2, D: 3 };
  const expectedFindingOrder = [...report.findings].sort((left, right) => {
    const levelDifference = localOrder[right.levelImpact] - localOrder[left.levelImpact];
    return levelDifference === 0 ? compareText(left.code, right.code) : levelDifference;
  });
  if (report.findings.some((finding, index) => finding !== expectedFindingOrder[index])) {
    context.addIssue({ code: "custom", message: "findings 必须按等级和 code 规范排序", path: ["findings"] });
  }
  const auditBlockers = report.blockingReasons.filter((reason) => reason.source === "audit");
  const workflowBlockers = report.blockingReasons.filter((reason) => reason.source === "workflow");
  auditBlockers.forEach((reason, blockerIndex) => {
    const matchingFindings = blockingFindings.filter((finding) => finding.code === reason.code);
    const matchingFinding = matchingFindings[0];
    if (
      matchingFindings.length !== 1
      || reason.levelImpact === null
      || matchingFinding === undefined
      || reason.levelImpact !== matchingFinding.levelImpact
      || reason.summary !== matchingFinding.summary
      || JSON.stringify(reason.candidateIds) !== JSON.stringify(matchingFinding.candidateIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "audit blocker 必须对应唯一 blocking finding",
        path: ["blockingReasons", blockerIndex]
      });
    }
    reason.candidateIds.forEach((candidateId, candidateIndex) => {
      if (!candidateIdSet.has(candidateId)) {
        context.addIssue({
          code: "custom",
          message: "blockingReason 引用了不存在的候选",
          path: ["blockingReasons", blockerIndex, "candidateIds", candidateIndex]
        });
      }
    });
  });
  blockingFindings.forEach((finding) => {
    if (auditBlockers.filter((reason) => reason.code === finding.code).length !== 1) {
      context.addIssue({
        code: "custom",
        message: "每个 blocking finding 必须对应唯一 audit blocker",
        path: ["blockingReasons"]
      });
    }
  });
  if (new Set(report.blockingReasons.map((reason) => `${reason.source}:${reason.code}`)).size !== report.blockingReasons.length) {
    context.addIssue({ code: "custom", message: "blockingReason 不得重复", path: ["blockingReasons"] });
  }
  const expectedBlockerCodes = [
    ...blockingFindings.map((finding) => `audit:${finding.code}`),
    ...(report.workflowStatus === "void" ? ["workflow:WORKFLOW_VOID"] : [])
  ];
  if (
    JSON.stringify(report.blockingReasons.map((reason) => `${reason.source}:${reason.code}`))
    !== JSON.stringify(expectedBlockerCodes)
  ) {
    context.addIssue({ code: "custom", message: "blockingReasons 必须跟随 finding 规范顺序", path: ["blockingReasons"] });
  }

  if (report.workflowStatus === "void") {
    if (
      workflowBlockers.length !== 1
      || workflowBlockers[0]?.code !== "WORKFLOW_VOID"
      || workflowBlockers[0]?.levelImpact !== null
      || report.allowedAnalysisModes.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "void 报告必须且只能有一个 WORKFLOW_VOID，并禁用全部模式",
        path: ["blockingReasons"]
      });
    }
  } else if (workflowBlockers.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "非 void 报告不得包含 workflow blocker",
      path: ["blockingReasons"]
    });
  }

  if (report.workflowStatus !== "void") {
    const serializedModes = JSON.stringify(report.allowedAnalysisModes);
    const validModes = report.auditLevel === "A"
      ? serializedModes === JSON.stringify(["full_dual", "provisional_dual", "single_track", "data_diagnosis"])
      : report.auditLevel === "B"
        ? serializedModes === JSON.stringify(["provisional_dual", "single_track", "data_diagnosis"])
        : report.auditLevel === "C"
          ? serializedModes === JSON.stringify(["single_track", "data_diagnosis"])
            || serializedModes === JSON.stringify(["data_diagnosis"])
          : serializedModes === JSON.stringify(["data_diagnosis"]);
    if (!validModes) {
      context.addIssue({
        code: "custom",
        message: "allowedAnalysisModes 与审计等级不一致",
        path: ["allowedAnalysisModes"]
      });
    }
  }

  if ((report.auditLevel === "A" || report.auditLevel === "B") && auditBlockers.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "A/B 报告不得包含 audit blocker",
      path: ["blockingReasons"]
    });
  }
  if ((report.auditLevel === "C" || report.auditLevel === "D") && auditBlockers.length === 0) {
    context.addIssue({
      code: "custom",
      message: "C/D 报告至少需要一个 audit blocker",
      path: ["blockingReasons"]
    });
  }

  const expectedLevel = report.findings.reduce<AuditLevelV1>((maximum, finding) => (
    localOrder[finding.levelImpact] > localOrder[maximum] ? finding.levelImpact : maximum
  ), "A");
  if (report.auditLevel !== expectedLevel) {
    context.addIssue({ code: "custom", message: "auditLevel 必须等于 findings 最大等级", path: ["auditLevel"] });
  }

  if (
    report.manualDecision.status === "selected"
    && !candidateIdSet.has(report.manualDecision.selectedCandidateId)
  ) {
    context.addIssue({
      code: "custom",
      message: "manualDecision 引用了不存在的候选",
      path: ["manualDecision", "selectedCandidateId"]
    });
  }
  if (report.manualDecision.status === "voided" && report.workflowStatus !== "void") {
    context.addIssue({
      code: "custom",
      message: "voided decision 要求 void workflow",
      path: ["manualDecision", "status"]
    });
  }
  if (
    report.manualDecision.status !== "none"
    && JSON.stringify(report.manualDecision.evidenceRefs) !== JSON.stringify(sortedUnique(report.manualDecision.evidenceRefs))
  ) {
    context.addIssue({
      code: "custom",
      message: "manualDecision.evidenceRefs 必须唯一且规范排序",
      path: ["manualDecision", "evidenceRefs"]
    });
  }
}

export const AuditReportV1Schema = AuditReportV1OuterSchema.superRefine((report, context) => {
  refineAuditReport(report, context, assessAuditVersionEvidence);
});

export interface V4ProvidedTimeAuditBoundary {
  engineVersions: Pick<VersionEvidenceV3, "timeInputBasis">;
  timeInputBoundary: {
    basis: VersionEvidenceV3["timeInputBasis"];
    assertionCode: "provided_apparent_solar" | "provided_civil_clock";
  };
  provenanceFlags?: readonly string[];
}

export function isV4ProvidedTimeAuditBoundaryConsistent(report: V4ProvidedTimeAuditBoundary): boolean {
  const apparentSolar = report.engineVersions.timeInputBasis === "apparent_solar_provided";
  const expectedAssertionCode = apparentSolar ? "provided_apparent_solar" : "provided_civil_clock";
  const expectedBasisFlag = apparentSolar ? "provided_time_apparent_solar" : "provided_time_civil_clock";
  const conflictingBasisFlag = apparentSolar ? "provided_time_civil_clock" : "provided_time_apparent_solar";
  const flags = report.provenanceFlags;
  return report.timeInputBoundary.basis === report.engineVersions.timeInputBasis
    && report.timeInputBoundary.assertionCode === expectedAssertionCode
    && flags !== undefined
    && new Set(flags).size === flags.length
    && flags.includes(expectedBasisFlag)
    && !flags.includes(conflictingBasisFlag)
    && flags.every((flag) => flag === expectedBasisFlag || flag === "provided_time_source_note_present");
}

export const AuditReportV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  auditReportId: z.string().min(1),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  revisionId: z.string().regex(/^R\d{3}$/u),
  candidateIds: z.array(z.string().min(1)),
  rulesetVersion: z.literal("CyberSaga-Audit-v2"),
  engineVersions: VersionEvidenceV3Schema,
  provenanceFlags: z.array(z.string().min(1)).optional(),
  timeInputBoundary: z.object({
    basis: ProvidedTimeBasisV1Schema,
    assertionCode: z.enum(["provided_apparent_solar", "provided_civil_clock"])
  }).strict(),
  auditLevel: z.enum(["A", "B", "C", "D"]),
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  findings: z.array(AuditFindingV1Schema),
  blockingReasons: z.array(BlockingReasonV1Schema),
  allowedAnalysisModes: z.array(z.enum([
    "full_dual",
    "provisional_dual",
    "single_track",
    "data_diagnosis"
  ])),
  manualDecision: ManualDecisionV1Schema,
  contentFingerprint: ContentFingerprintV2Schema
}).strict().superRefine((report, context) => {
  refineAuditReport(report, context, assessAuditVersionEvidenceV3);
  if (!isV4ProvidedTimeAuditBoundaryConsistent(report)) {
    context.addIssue({
      code: "custom",
      message: "V4 时间输入证据、边界与公开来源标记必须一致",
      path: ["timeInputBoundary"]
    });
  }
});

export type AuditReportV1 = z.infer<typeof AuditReportV1Schema>;
export type AuditReportV2 = z.infer<typeof AuditReportV2Schema>;
export type VersionedAuditReport = AuditReportV1 | AuditReportV2;

export function parseAuditReportForContract(
  marker: AuditContractVersion,
  value: unknown
): VersionedAuditReport {
  if (marker === AUDIT_CONTRACT_VERSION_V4) return AuditReportV2Schema.parse(value);
  if (
    marker === AUDIT_CONTRACT_VERSION_V1
    || marker === AUDIT_CONTRACT_VERSION_V2
    || marker === AUDIT_CONTRACT_VERSION_V3
  ) return AuditReportV1Schema.parse(value);
  throw new TypeError("UNSUPPORTED_AUDIT_CONTRACT_VERSION");
}

interface MaterialState {
  allComplete: boolean;
  sameBazi: boolean;
  sameZiwei: boolean;
  sameDualChart: boolean;
}

const TIME_ISSUE_DEFINITIONS = {
  dst_overlap: { severity: "blocking", minimumCandidates: 2 },
  dst_gap: { severity: "blocking", minimumCandidates: 2 },
  dst_unknown: { severity: "blocking", minimumCandidates: 1 },
  true_solar_branch_change: { severity: "blocking", minimumCandidates: 2 },
  true_solar_same_branch: { severity: "warning", minimumCandidates: 2 },
  late_zi_ambiguity: { severity: "blocking", minimumCandidates: 2 },
  leap_month_ambiguity: { severity: "blocking", minimumCandidates: 2 },
  leap_month_alternative_invalid: { severity: "blocking", minimumCandidates: 1 },
  historical_uncertainty: { severity: "warning", minimumCandidates: 1 },
  future_provisional: { severity: "warning", minimumCandidates: 1 },
  standard_offset_unresolved: { severity: "blocking", minimumCandidates: 1 }
} as const;

type KnownTimeIssueCode = keyof typeof TIME_ISSUE_DEFINITIONS;

export const AUDIT_EXPECTED_VERSION_EVIDENCE = {
  auditRuleset: "CyberSaga-Audit-v1",
  timeRuleset: "CyberSaga-Time-v1",
  baziRuleset: "CyberSaga-Bazi-v1",
  ziweiRuleset: "CyberSaga-Ziwei-v1",
  lunarEngine: { name: "lunar-typescript", version: "1.8.6" },
  ziweiEngine: { name: "iztro", version: "2.5.8" },
  xinjiangLocationRule: XINJIANG_LOCATION_RULE_EVIDENCE,
  unknownBirthplaceRule: UNKNOWN_BIRTHPLACE_RULE_EVIDENCE,
  ruleSnapshotSha256: RULE_SNAPSHOT_HASHES,
  timezoneEngine: {
    corePackage: "@js-joda/core",
    coreVersion: "6.1.0",
    timezonePackage: "@js-joda/timezone",
    timezoneVersion: "2.25.2",
    tzdbVersion: "2026a",
    buildFile: "dist/js-joda-timezone.esm.js",
    buildSha256: "97f73005978d13a8b633964727bdfacbfaa4ae033768cc524aafb3e4b11dd6ec"
  }
} as const;

export const AUDIT_EXPECTED_VERSION_EVIDENCE_V2 = {
  auditRuleset: "CyberSaga-Audit-v1",
  timeRuleset: "CyberSaga-Provided-Time-v1",
  baziRuleset: "CyberSaga-Bazi-v1",
  ziweiRuleset: "CyberSaga-Ziwei-v1",
  providedTimeRule: PROVIDED_TIME_RULE_EVIDENCE,
  lunarEngine: { name: "lunar-typescript", version: "1.8.6" },
  ziweiEngine: { name: "iztro", version: "2.5.8" },
  ruleSnapshotSha256: {
    audit: RULESET_SECTION_SHA256.audit,
    bazi: RULESET_SECTION_SHA256.bazi,
    ziwei: RULESET_SECTION_SHA256.ziwei,
    providedTime: PROVIDED_TIME_RULE_EVIDENCE.contentSha256
  }
} as const;

export const AUDIT_EXPECTED_VERSION_EVIDENCE_V3 = {
  auditRuleset: "CyberSaga-Audit-v2",
  timeRuleset: "CyberSaga-Provided-Time-v1",
  baziRuleset: "CyberSaga-Bazi-v1",
  baziDetailRuleset: "CyberSaga-Bazi-Detail-v1",
  ziweiRuleset: "CyberSaga-Ziwei-v1",
  providedTimeRule: PROVIDED_TIME_RULE_EVIDENCE,
  lunarEngine: { name: "lunar-typescript", version: "1.8.6" },
  baziDetailEngine: { name: "lunar-typescript", version: "1.8.6" },
  ziweiEngine: { name: "iztro", version: "2.5.8" },
  ruleSnapshotSha256: {
    audit: AUDIT_RULE_V2_SHA256,
    bazi: RULESET_SECTION_SHA256.bazi,
    baziDetail: BAZI_DETAIL_RULE_V1_SHA256,
    ziwei: RULESET_SECTION_SHA256.ziwei,
    providedTime: PROVIDED_TIME_RULE_EVIDENCE.contentSha256
  }
} as const;

const KNOWN_PROVENANCE_FLAGS = new Set([
  "calendar_basis_conflict",
  "calendar_candidates_complete",
  "leap_month_unresolved",
  "explicit_guess",
  "source_conflict",
  "location_conflict",
  "clock_convention_unresolved",
  "xinjiang_clock_convention_unresolved",
  "dual_track_source_mismatch",
  "representative_coordinate",
  "location_coordinate_unknown",
  "provided_time_apparent_solar",
  "provided_time_civil_clock",
  "provided_time_source_note_present"
]);

const LEVEL_ORDER: Record<AuditLevelV1, number> = { A: 0, B: 1, C: 2, D: 3 };

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

const compareText = compareUnicodeCodePoints;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function canonicalString(value: JsonValue): string {
  const result = canonicalize(value);
  if (typeof result !== "string") {
    throw new TypeError("审计内容无法规范序列化");
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("审计内容不允许非有限数字");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => item === undefined ? null : jsonValue(item));
  }
  if (typeof value === "object" && value !== null) {
    const normalized: { [key: string]: JsonValue } = {};
    Object.entries(value).sort(([left], [right]) => compareText(left, right)).forEach(([key, item]) => {
      if (item !== undefined) normalized[key] = jsonValue(item);
    });
    return normalized;
  }
  throw new TypeError("审计内容包含不支持的 JSON 值");
}

export interface AuditContentFingerprintV2MaterialInput {
  birthRecord: JsonValue;
  timeEvidence: JsonValue;
  chartSet: JsonValue;
  baziDetail: BaziDetailV1;
  versionEvidence: JsonValue;
  timeInputBoundary: JsonValue;
  provenanceFlags: JsonValue;
  precisionCoverage: JsonValue;
  artifactManifest: JsonValue;
  manualDecision: JsonValue;
}

const AuditContentFingerprintV2MaterialSchema = z.object({
  birthRecord: JsonValueSchema,
  timeEvidence: JsonValueSchema,
  chartSet: JsonValueSchema,
  baziDetail: BaziDetailV1Schema,
  versionEvidence: JsonValueSchema,
  timeInputBoundary: JsonValueSchema,
  provenanceFlags: JsonValueSchema,
  precisionCoverage: JsonValueSchema,
  artifactManifest: JsonValueSchema,
  manualDecision: JsonValueSchema
}).strict();

export function auditContentFingerprintV2Material(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  value: unknown
): Uint8Array {
  if (marker !== AUDIT_CONTRACT_VERSION_V4) throw new TypeError("V4_AUDIT_MARKER_REQUIRED");
  const parsed = AuditContentFingerprintV2MaterialSchema.parse(value);
  return new TextEncoder().encode(canonicalString(jsonValue(parsed)));
}

export function computeAuditContentFingerprintV2(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  value: unknown
): ContentFingerprintV2 {
  const material = auditContentFingerprintV2Material(marker, value);
  return ContentFingerprintV2Schema.parse({
    algorithm: "sha256",
    canonicalization: "json-canonicalize@2.0.0",
    scope: "provided-time-charts-bazi-detail-rules-manual-v1",
    value: createHash("sha256").update(material).digest("hex")
  });
}

function sortedStars<T extends { name: string; type: string; scope: string; brightness: string | null; transformation: string | null }>(
  stars: readonly T[]
): T[] {
  return [...stars].sort((left, right) => compareText(
    [left.name, left.type, left.scope, left.brightness ?? "", left.transformation ?? ""].join("\u0000"),
    [right.name, right.type, right.scope, right.brightness ?? "", right.transformation ?? ""].join("\u0000")
  ));
}

export function materialBaziProjection(rawChart: unknown): JsonValue {
  const chart = BaziChartAuditSchema.parse(rawChart);
  return jsonValue({
    rulesetVersion: chart.rulesetVersion,
    configuration: chart.configuration,
    calendar: {
      solarDate: chart.calendar.solarDate,
      lunarYear: chart.calendar.lunarYear,
      lunarMonth: chart.calendar.lunarMonth,
      lunarDay: chart.calendar.lunarDay,
      isLeapMonth: chart.calendar.isLeapMonth,
      lunarText: chart.calendar.lunarText
    },
    fourPillars: chart.fourPillars,
    pillars: chart.pillars,
    luck: {
      ...chart.luck,
      daYun: [...chart.luck.daYun].sort((left, right) => left.index - right.index)
    },
    annualFortunes: [...chart.annualFortunes].sort((left, right) => (
      left.year - right.year || left.daYunIndex - right.daYunIndex
    ))
  });
}

function normalizedHoroscopeItem<T extends ZiweiChartAudit["yearlyFortunes"][number]["yearly"]>(item: T) {
  return {
    ...item,
    starsByPalace: item.starsByPalace.map((stars) => sortedStars(stars))
  };
}

function normalizeEngineDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function materialZiweiProjection(rawChart: unknown): JsonValue {
  const chart = ZiweiChartAuditSchema.parse(rawChart);
  return jsonValue({
    rulesetVersion: chart.rulesetVersion,
    configuration: chart.configuration,
    gender: chart.gender,
    solarDate: chart.solarDate,
    lunarDate: chart.lunarDate,
    chineseDate: chart.chineseDate,
    time: chart.time,
    timeRange: chart.timeRange,
    soulPalaceBranch: chart.soulPalaceBranch,
    bodyPalaceBranch: chart.bodyPalaceBranch,
    soul: chart.soul,
    body: chart.body,
    fiveElementsClass: chart.fiveElementsClass,
    palaces: [...chart.palaces].sort((left, right) => left.index - right.index).map((palace) => ({
      ...palace,
      majorStars: sortedStars(palace.majorStars),
      minorStars: sortedStars(palace.minorStars)
    })),
    transformations: [...chart.transformations].sort((left, right) => (
      left.palaceIndex - right.palaceIndex
      || compareText(left.starName, right.starName)
      || compareText(left.transformation, right.transformation)
    )),
    yearlyFortunes: [...chart.yearlyFortunes].sort((left, right) => left.targetYear - right.targetYear).map((fortune) => ({
      ...fortune,
      solarDate: normalizeEngineDate(fortune.solarDate),
      decadal: normalizedHoroscopeItem(fortune.decadal),
      yearly: normalizedHoroscopeItem(fortune.yearly)
    }))
  });
}

function materialHash(value: BaziChartAudit | ZiweiChartAudit, track: "bazi" | "ziwei"): string {
  const projection = track === "bazi"
    ? materialBaziProjection(value)
    : materialZiweiProjection(value);
  return sha256(canonicalString(projection));
}

function normalizedTrackProjection(
  track: BaziChartAudit | ZiweiChartAudit | { status: "error"; errorCode: string; message: string },
  kind: "bazi" | "ziwei"
): JsonValue {
  if (isTrackFailure(track)) return jsonValue(track);
  return kind === "bazi" ? materialBaziProjection(track) : materialZiweiProjection(track);
}

function normalizedChartSetProjection(chartSet: DualTrackChartSetAudit): JsonValue {
  return jsonValue({
    schemaVersion: chartSet.schemaVersion,
    caseId: chartSet.caseId,
    timeRulesetVersion: chartSet.timeRulesetVersion,
    engineVersions: chartSet.engineVersions,
    chartRulesetVersions: chartSet.chartRulesetVersions,
    targetYears: [...chartSet.targetYears].sort((left, right) => left - right),
    candidates: [...chartSet.candidates]
      .sort((left, right) => compareText(left.candidateId, right.candidateId))
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        basis: candidate.basis,
        dayBoundary: candidate.dayBoundary,
        calendarResolutionId: candidate.calendarResolutionId,
        calendarBasis: candidate.calendarBasis,
        bazi: normalizedTrackProjection(candidate.bazi, "bazi"),
        ziwei: normalizedTrackProjection(candidate.ziwei, "ziwei")
      }))
  });
}

function successfulTracksMatchReplay(
  actual: DualTrackChartSetAudit,
  expected: DualTrackChartSetAudit
): boolean {
  const actualHeader = jsonValue({
    schemaVersion: actual.schemaVersion,
    caseId: actual.caseId,
    timeRulesetVersion: actual.timeRulesetVersion,
    engineVersions: actual.engineVersions,
    chartRulesetVersions: actual.chartRulesetVersions,
    targetYears: [...actual.targetYears].sort((left, right) => left - right)
  });
  const expectedHeader = jsonValue({
    schemaVersion: expected.schemaVersion,
    caseId: expected.caseId,
    timeRulesetVersion: expected.timeRulesetVersion,
    engineVersions: expected.engineVersions,
    chartRulesetVersions: expected.chartRulesetVersions,
    targetYears: [...expected.targetYears].sort((left, right) => left - right)
  });
  if (canonicalString(actualHeader) !== canonicalString(expectedHeader)) return false;

  const expectedById = new Map(expected.candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (actual.candidates.length !== expected.candidates.length) return false;
  for (const candidate of actual.candidates) {
    const replayed = expectedById.get(candidate.candidateId);
    if (
      replayed === undefined
      || candidate.basis !== replayed.basis
      || candidate.dayBoundary !== replayed.dayBoundary
      || candidate.calendarResolutionId !== replayed.calendarResolutionId
      || candidate.calendarBasis !== replayed.calendarBasis
    ) return false;
    if (
      !isTrackFailure(candidate.bazi)
      && (
        isTrackFailure(replayed.bazi)
        || canonicalString(materialBaziProjection(candidate.bazi))
          !== canonicalString(materialBaziProjection(replayed.bazi))
      )
    ) return false;
    if (
      !isTrackFailure(candidate.ziwei)
      && (
        isTrackFailure(replayed.ziwei)
        || canonicalString(materialZiweiProjection(candidate.ziwei))
          !== canonicalString(materialZiweiProjection(replayed.ziwei))
      )
    ) return false;
  }
  return true;
}

type CoverageSampleV1 = z.infer<typeof CoverageSampleV1Schema>;

function recordForCoverageSample(
  source: BirthRecordV1,
  sample: CoverageSampleV1,
  kind: "precision" | "representative_coordinate" | "leap_month"
): BirthRecordV1 | null {
  const record = structuredClone(source);
  if (kind === "precision") {
    if (sample.localDateTime === undefined) return null;
    record.calendar = {
      type: "solar",
      date: sample.localDateTime.slice(0, 10),
      leapMonth: false
    };
    record.birthTime.localTime = sample.localDateTime.slice(11, 16);
    return record;
  }
  if (kind === "representative_coordinate") {
    if (sample.longitude === undefined) return null;
    record.location.longitude = sample.longitude;
    return record;
  }
  const solar = /^solar:(\d{4}-\d{2}-\d{2})$/u.exec(sample.calendarKey ?? "");
  if (solar !== null) {
    record.calendar = { type: "solar", date: solar[1], leapMonth: false };
    return record;
  }
  const lunar = /^lunar:(\d{4}-\d{2}-\d{2}):(regular|leap)$/u.exec(sample.calendarKey ?? "");
  if (lunar !== null) {
    record.calendar = { type: "lunar", date: lunar[1], leapMonth: lunar[2] === "leap" };
    return record;
  }
  return null;
}

function replayCoverageSamples(
  input: NormalizedAuditInputV1,
  samples: readonly CoverageSampleV1[],
  kind: "precision" | "representative_coordinate" | "leap_month"
): { valid: boolean; sameDualChart: boolean } {
  const invalid = { valid: false, sameDualChart: false };
  if (input.inputKind !== "chart_set" || samples.length < 2) return invalid;
  const sampleIds = samples.map((sample) => sample.sampleId);
  const scenarioKeys = samples.map((sample) => (
    kind === "precision" ? sample.localDateTime
      : kind === "representative_coordinate" ? sample.longitude
        : sample.calendarKey
  ));
  if (
    new Set(sampleIds).size !== sampleIds.length
    || scenarioKeys.some((value) => value === undefined)
    || new Set(scenarioKeys).size !== scenarioKeys.length
  ) return invalid;

  const baziHashes = new Set<string>();
  const ziweiHashes = new Set<string>();
  try {
    for (const sample of samples) {
      const record = recordForCoverageSample(input.birthRecord, sample, kind);
      if (record === null) return invalid;
      const evidence = normalizeBirthTime(record);
      const chartSet = calculateCandidateCharts(record, evidence, { targetYears: input.chartSet.targetYears });
      const candidate = chartSet.candidates.find((item) => item.candidateId === sample.candidateId);
      if (candidate === undefined) return invalid;
      baziHashes.add(materialHash(candidate.bazi, "bazi"));
      ziweiHashes.add(materialHash(candidate.ziwei, "ziwei"));
    }
  } catch {
    return invalid;
  }
  return {
    valid: true,
    sameDualChart: baziHashes.size === 1 && ziweiHashes.size === 1
  };
}

function trackIsUsable(
  bundle: AuditableChartBundleV1,
  track: "bazi" | "ziwei"
): boolean {
  return !isTrackFailure(bundle[track]);
}

function materialState(
  input: NormalizedAuditInputV1,
  selectedCandidateIds?: readonly string[]
): MaterialState {
  const expectedIds = sortedUnique(
    selectedCandidateIds ?? input.timeEvidence.candidates.map((candidate) => candidate.id)
  );
  const byId = new Map(input.chartBundles.map((bundle) => [bundle.candidateId, bundle]));
  const bundles = expectedIds.map((candidateId) => byId.get(candidateId));
  const allBazi = bundles.every((bundle) => bundle !== undefined && trackIsUsable(bundle, "bazi"));
  const allZiwei = bundles.every((bundle) => bundle !== undefined && trackIsUsable(bundle, "ziwei"));
  const baziHashes = new Set(bundles.flatMap((bundle) => (
    bundle !== undefined && trackIsUsable(bundle, "bazi") && !isTrackFailure(bundle.bazi)
      ? [materialHash(bundle.bazi, "bazi")]
      : []
  )));
  const ziweiHashes = new Set(bundles.flatMap((bundle) => (
    bundle !== undefined && trackIsUsable(bundle, "ziwei") && !isTrackFailure(bundle.ziwei)
      ? [materialHash(bundle.ziwei, "ziwei")]
      : []
  )));
  const sameBazi = allBazi && baziHashes.size === 1;
  const sameZiwei = allZiwei && ziweiHashes.size === 1;
  return {
    allComplete: allBazi && allZiwei,
    sameBazi,
    sameZiwei,
    sameDualChart: sameBazi && sameZiwei
  };
}

function isKnownTimeIssueCode(code: string): code is KnownTimeIssueCode {
  return Object.hasOwn(TIME_ISSUE_DEFINITIONS, code);
}

interface FindingAccumulator {
  code: AuditFindingCodeV1;
  candidateIds: Set<string>;
  evidenceRefs: Set<string>;
}

function makeFinding(
  code: AuditFindingCodeV1,
  candidateIds: readonly string[] = [],
  evidenceRefs: readonly string[] = []
): FindingAccumulator {
  return { code, candidateIds: new Set(candidateIds), evidenceRefs: new Set(evidenceRefs) };
}

function materializeFindings(accumulators: FindingAccumulator[]): AuditReportV1["findings"] {
  const merged = new Map<AuditFindingCodeV1, FindingAccumulator>();
  for (const finding of accumulators) {
    const existing = merged.get(finding.code) ?? makeFinding(finding.code);
    finding.candidateIds.forEach((candidateId) => existing.candidateIds.add(candidateId));
    finding.evidenceRefs.forEach((reference) => existing.evidenceRefs.add(reference));
    merged.set(finding.code, existing);
  }
  return [...merged.values()].map((finding) => ({
    code: finding.code,
    ...FINDING_REGISTRY[finding.code],
    candidateIds: sortedUnique([...finding.candidateIds]),
    evidenceRefs: sortedUnique([...finding.evidenceRefs])
  })).sort((left, right) => {
    const levelDifference = LEVEL_ORDER[right.levelImpact] - LEVEL_ORDER[left.levelImpact];
    return levelDifference === 0 ? compareText(left.code, right.code) : levelDifference;
  });
}

function maxAuditLevel(findings: AuditReportV1["findings"]): AuditLevelV1 {
  return findings.reduce<AuditLevelV1>((maximum, finding) => (
    LEVEL_ORDER[finding.levelImpact] > LEVEL_ORDER[maximum] ? finding.levelImpact : maximum
  ), "A");
}

function normalizeManualDecision(decision: ManualDecisionV1): ManualDecisionV1 {
  if (decision.status === "none") return decision;
  return {
    ...decision,
    evidenceRefs: sortedUnique(decision.evidenceRefs)
  };
}

export function deriveVersionEvidence(
  chartSet: DualTrackChartSetAudit,
  timeEvidence: { schemaVersion: "1.0.0"; timezoneEngine: VersionEvidenceV1["timezoneEngine"] }
): VersionEvidenceV1;
export function deriveVersionEvidence(
  chartSet: DualTrackChartSetAudit,
  timeEvidence: TimeEvidenceV2
): VersionEvidenceV2;
export function deriveVersionEvidence(
  chartSet: DualTrackChartSetAudit,
  timeEvidence: { schemaVersion: "1.0.0"; timezoneEngine: VersionEvidenceV1["timezoneEngine"] } | TimeEvidenceV2
): VersionEvidenceV1 | VersionEvidenceV2 {
  if (timeEvidence.schemaVersion === "2.0.0") {
    return VersionEvidenceV2Schema.parse({
      auditRuleset: "CyberSaga-Audit-v1",
      timeRuleset: chartSet.timeRulesetVersion,
      baziRuleset: chartSet.chartRulesetVersions.bazi,
      ziweiRuleset: chartSet.chartRulesetVersions.ziwei,
      providedTimeRule: PROVIDED_TIME_RULE_EVIDENCE,
      timeInputBasis: timeEvidence.originalTimeBasis,
      lunarEngine: chartSet.engineVersions.bazi,
      ziweiEngine: chartSet.engineVersions.ziwei,
      ruleSnapshotSha256: AUDIT_EXPECTED_VERSION_EVIDENCE_V2.ruleSnapshotSha256
    });
  }
  return VersionEvidenceV1Schema.parse({
    auditRuleset: "CyberSaga-Audit-v1",
    timeRuleset: chartSet.timeRulesetVersion,
    baziRuleset: chartSet.chartRulesetVersions.bazi,
    ziweiRuleset: chartSet.chartRulesetVersions.ziwei,
    lunarEngine: chartSet.engineVersions.bazi,
    ziweiEngine: chartSet.engineVersions.ziwei,
    timezoneEngine: timeEvidence.timezoneEngine,
    xinjiangLocationRule: XINJIANG_LOCATION_RULE_EVIDENCE,
    unknownBirthplaceRule: UNKNOWN_BIRTHPLACE_RULE_EVIDENCE,
    ruleSnapshotSha256: RULE_SNAPSHOT_HASHES
  });
}

export function deriveVersionEvidenceV3(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  chartSet: DualTrackChartSetAudit,
  timeEvidence: TimeEvidenceV2
): VersionEvidenceV3 {
  if (marker !== AUDIT_CONTRACT_VERSION_V4) {
    throw new TypeError("V4_AUDIT_MARKER_REQUIRED");
  }
  return VersionEvidenceV3Schema.parse({
    ...AUDIT_EXPECTED_VERSION_EVIDENCE_V3,
    timeRuleset: chartSet.timeRulesetVersion,
    baziRuleset: chartSet.chartRulesetVersions.bazi,
    ziweiRuleset: chartSet.chartRulesetVersions.ziwei,
    timeInputBasis: timeEvidence.originalTimeBasis,
    lunarEngine: chartSet.engineVersions.bazi,
    baziDetailEngine: chartSet.engineVersions.bazi,
    ziweiEngine: chartSet.engineVersions.ziwei
  });
}

function normalizeAuditInput(input: ParsedAuditInputV1): NormalizedAuditInputV1 {
  if ("chartSet" in input) {
    return {
      ...input,
      chartSet: input.chartSet,
      chartBundles: input.chartSet.candidates,
      versionEvidence: input.versionEvidence ?? null,
      inputKind: "chart_set"
    };
  }

  const timeCandidateById = new Map(input.timeEvidence.candidates.map((candidate) => [candidate.id, candidate]));
  const chartBundles = input.chartBundles.map((bundle) => {
    const candidate = timeCandidateById.get(bundle.candidateId);
    return AuditableChartBundleV1Schema.parse({
      ...bundle,
      basis: bundle.basis ?? candidate?.basis ?? "civil_iana",
      dayBoundary: bundle.dayBoundary ?? candidate?.dayBoundary ?? "current",
      calendarResolutionId: bundle.calendarResolutionId ?? candidate?.calendarResolutionId,
      calendarBasis: bundle.calendarBasis ?? candidate?.calendarBasis
    });
  });
  const targetYears = sortedUnique(chartBundles.flatMap((bundle) => [
    ...(isTrackFailure(bundle.bazi) ? [] : bundle.bazi.annualFortunes.map((fortune) => String(fortune.year))),
    ...(isTrackFailure(bundle.ziwei) ? [] : bundle.ziwei.yearlyFortunes.map((fortune) => String(fortune.targetYear)))
  ])).map(Number);
  const fallbackSolarDate = input.timeEvidence.solarDate
    ?? input.timeEvidence.calendarResolutions.find((resolution) => resolution.status === "valid")?.solarDate
    ?? input.timeEvidence.candidates[0]?.localDateTime.slice(0, 10)
    ?? input.birthRecord.calendar.date;
  const chartSet = DualTrackChartSetAuditSchema.parse({
    schemaVersion: "1.0.0",
    caseId: input.birthRecord.caseId,
    timeRulesetVersion: input.versionEvidence.timeRuleset,
    engineVersions: {
      bazi: input.versionEvidence.lunarEngine,
      ziwei: input.versionEvidence.ziweiEngine
    },
    chartRulesetVersions: {
      bazi: input.versionEvidence.baziRuleset,
      ziwei: input.versionEvidence.ziweiRuleset
    },
    targetYears: targetYears.length === 0 ? [Number(fallbackSolarDate.slice(0, 4))] : targetYears,
    candidates: chartBundles
  });
  return {
    ...input,
    chartSet,
    chartBundles,
    versionEvidence: input.versionEvidence,
    inputKind: "legacy_bundles"
  };
}

function normalizedTimeEvidenceValue(evidence: NormalizedAuditInputV1["timeEvidence"]): JsonValue {
  const calendarResolutions = [...evidence.calendarResolutions]
    .sort((left, right) => compareText(left.id, right.id));
  const candidates = [...evidence.candidates]
    .map((candidate) => ({ ...candidate, warnings: sortedUnique(candidate.warnings) }))
    .sort((left, right) => compareText(left.id, right.id));
  const issues = [...evidence.issues]
    .map((issue) => ({ ...issue, candidateIds: sortedUnique(issue.candidateIds) }))
    .sort((left, right) => {
      const codeDifference = compareText(left.code, right.code);
      if (codeDifference !== 0) return codeDifference;
      const candidateDifference = compareText(left.candidateIds.join("\u0000"), right.candidateIds.join("\u0000"));
      return candidateDifference !== 0 ? candidateDifference : compareText(left.message, right.message);
    });
  return jsonValue({ ...evidence, calendarResolutions, candidates, issues });
}

function normalizedTimeEvidence(input: NormalizedAuditInputV1): JsonValue {
  return normalizedTimeEvidenceValue(input.timeEvidence);
}

function normalizedCoverageProof<T extends { samples: CoverageSampleV1[] }>(proof: T): JsonValue {
  return jsonValue({
    ...proof,
    samples: [...proof.samples].sort((left, right) => {
      const sampleDifference = compareText(left.sampleId, right.sampleId);
      if (sampleDifference !== 0) return sampleDifference;
      return compareText(canonicalString(jsonValue(left)), canonicalString(jsonValue(right)));
    })
  });
}

function contentFingerprint(input: NormalizedAuditInputV1): AuditReportV1["contentFingerprint"] {
  const { privateName: _privateName, ...birthRecord } = input.birthRecord;
  const preimage = jsonValue({
    birthRecord,
    timeEvidence: normalizedTimeEvidence(input),
    chartSet: normalizedChartSetProjection(input.chartSet),
    versionEvidence: input.versionEvidence,
    provenanceFlags: sortedUnique(input.provenanceFlags),
    precisionCoverage: {
      ...input.precisionCoverage,
      candidateIds: sortedUnique(input.precisionCoverage.candidateIds),
      proof: input.precisionCoverage.proof === null
        ? null
        : normalizedCoverageProof(input.precisionCoverage.proof)
    },
    uncertaintyProofs: [...input.uncertaintyProofs]
      .sort((left, right) => compareText(left.kind, right.kind))
      .map((proof) => normalizedCoverageProof(proof)),
    artifactManifest: {
      artifacts: [...input.artifactManifest.artifacts].sort((left, right) => (
        compareText(left.artifactId, right.artifactId) || compareText(left.sha256, right.sha256)
      ))
    },
    manualDecision: normalizeManualDecision(input.manualDecision)
  });
  return {
    algorithm: "sha256",
    canonicalization: "json-canonicalize@2.0.0",
    scope: "birth-time-charts-rules-manual-v1",
    value: sha256(canonicalString(preimage))
  };
}

function providedTimeContentFingerprint(input: ParsedAuditInputV2): AuditReportV1["contentFingerprint"] {
  const boundary = PROVIDED_TIME_PRESENTATION[input.birthRecord.providedTime.basis];
  const preimage = jsonValue({
    birthRecord: input.birthRecord,
    timeEvidence: input.timeEvidence,
    chartSet: normalizedChartSetProjection(input.chartSet),
    versionEvidence: input.versionEvidence,
    timeInputBoundary: {
      basis: input.birthRecord.providedTime.basis,
      assertionCode: boundary.assertionCode
    },
    provenanceFlags: sortedUnique(input.provenanceFlags),
    precisionCoverage: {
      ...input.precisionCoverage,
      candidateIds: sortedUnique(input.precisionCoverage.candidateIds),
      proof: input.precisionCoverage.proof === null
        ? null
        : normalizedCoverageProof(input.precisionCoverage.proof)
    },
    artifactManifest: {
      artifacts: [...input.artifactManifest.artifacts].sort((left, right) => (
        compareText(left.artifactId, right.artifactId) || compareText(left.sha256, right.sha256)
      ))
    },
    manualDecision: normalizeManualDecision(input.manualDecision)
  });
  return {
    algorithm: "sha256",
    canonicalization: "json-canonicalize@2.0.0",
    scope: "provided-time-charts-rules-manual-v1",
    value: sha256(canonicalString(preimage))
  };
}

function allowedModes(
  level: AuditLevelV1,
  workflowStatus: AuditInputV1["workflowStatus"],
  state: MaterialState
): AuditReportV1["allowedAnalysisModes"] {
  if (workflowStatus === "void") return [];
  if (level === "A") return ["full_dual", "provisional_dual", "single_track", "data_diagnosis"];
  if (level === "B") return ["provisional_dual", "single_track", "data_diagnosis"];
  if (level === "C") {
    return state.sameBazi || state.sameZiwei
      ? ["single_track", "data_diagnosis"]
      : ["data_diagnosis"];
  }
  return ["data_diagnosis"];
}

function buildHistoricalAuditReport(rawInput: unknown): AuditReportV1 {
  const parsedInput = AuditInputV1Schema.parse(rawInput);
  const input = normalizeAuditInput(parsedInput);
  const candidateIds = sortedUnique(input.timeEvidence.candidates.map((candidate) => candidate.id));
  const state = materialState(input);
  const fingerprint = contentFingerprint(input);
  const findings: FindingAccumulator[] = [];

  const sourceFingerprint = sourceRecordFingerprint(input.birthRecord);
  if (input.timeEvidence.sourceRecordFingerprint !== sourceFingerprint) {
    findings.push(makeFinding(
      "SOURCE_RECORD_FINGERPRINT_MISMATCH",
      candidateIds,
      ["timeEvidence.sourceRecordFingerprint"]
    ));
  }

  let expectedTimeEvidence: ReturnType<typeof normalizeBirthTime> | null = null;
  try {
    expectedTimeEvidence = normalizeBirthTime(input.birthRecord);
  } catch {
    expectedTimeEvidence = null;
  }
  const replayMismatch = expectedTimeEvidence === null
    || canonicalString(normalizedTimeEvidenceValue(expectedTimeEvidence)) !== canonicalString(normalizedTimeEvidence(input));
  if (replayMismatch) {
    findings.push(makeFinding(
      "TIME_EVIDENCE_REPLAY_MISMATCH",
      candidateIds,
      ["birthRecord", "timeEvidence"]
    ));
  }

  let chartReplayMatches = false;
  try {
    const replayedEvidence = expectedTimeEvidence ?? normalizeBirthTime(input.birthRecord);
    const replayedCharts = DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
      input.birthRecord,
      replayedEvidence,
      { targetYears: input.chartSet.targetYears }
    ));
    chartReplayMatches = successfulTracksMatchReplay(input.chartSet, replayedCharts);
  } catch {
    chartReplayMatches = false;
  }
  if (!chartReplayMatches) {
    findings.push(makeFinding(
      "CHART_ENGINE_REPLAY_MISMATCH",
      candidateIds,
      [input.inputKind === "chart_set" ? "chartSet.engineReplay" : "chartBundles.engineReplay"]
    ));
  }

  const precisionProof = input.precisionCoverage.proof;
  const precisionReplay = precisionProof === null
    ? { valid: false, sameDualChart: false }
    : replayCoverageSamples(input, precisionProof.samples, "precision");
  const precisionProofValid = precisionProof !== null
    && precisionProof.sourceRecordFingerprint === sourceFingerprint
    && precisionProof.samples.length >= 2
    && new Set(precisionProof.samples.map((sample) => sample.sampleId)).size === precisionProof.samples.length
    && precisionProof.samples.every((sample) => input.precisionCoverage.candidateIds.includes(sample.candidateId))
    && precisionProof.samples.some((sample) => sample.localDateTime === precisionProof.interval.startLocalDateTime)
    && precisionProof.samples.some((sample) => sample.localDateTime === precisionProof.interval.endLocalDateTime)
    && precisionProof.interval.startLocalDateTime < precisionProof.interval.endLocalDateTime
    && precisionReplay.valid
    && precisionReplay.sameDualChart;

  switch (input.birthRecord.birthTime.precision) {
    case "minute":
      findings.push(makeFinding(
        input.precisionCoverage.complete ? "PRECISION_MINUTE" : "PRECISION_MINUTE_UNRESOLVED",
        input.precisionCoverage.candidateIds
      ));
      break;
    case "approximate":
      findings.push(makeFinding(
        input.precisionCoverage.complete && precisionProofValid && state.sameDualChart
          ? "PRECISION_APPROXIMATE_SAME_CHART"
          : "PRECISION_APPROXIMATE_UNRESOLVED",
        input.precisionCoverage.candidateIds
      ));
      break;
    case "branch":
      findings.push(makeFinding(
        input.precisionCoverage.complete && precisionProofValid && state.sameDualChart
          ? "PRECISION_BRANCH_SAME_CHART"
          : "PRECISION_BRANCH_UNRESOLVED",
        input.precisionCoverage.candidateIds
      ));
      break;
  }

  switch (input.birthRecord.birthTime.sourceType) {
    case "birth_certificate":
    case "hospital_record":
      findings.push(makeFinding("SOURCE_PRIMARY_DOCUMENTED"));
      break;
    case "family_memory":
      findings.push(makeFinding("SOURCE_FAMILY_MEMORY"));
      break;
    case "existing_chart":
      findings.push(makeFinding("SOURCE_EXISTING_CHART_ONLY"));
      break;
    case "unknown":
      findings.push(makeFinding("SOURCE_UNKNOWN"));
      break;
  }

  if (input.provenanceFlags.includes("source_conflict")) {
    findings.push(makeFinding("SOURCE_CONFLICT", candidateIds, ["birthRecord.birthTime"]));
  }
  if (input.provenanceFlags.includes("explicit_guess")) {
    findings.push(makeFinding("SOURCE_EXPLICIT_GUESS", candidateIds, ["birthRecord.birthTime"]));
  }
  if (input.provenanceFlags.includes("calendar_basis_conflict")) {
    findings.push(makeFinding("CALENDAR_BASIS_CONFLICT", candidateIds, ["birthRecord.calendar"]));
  }
  if (input.provenanceFlags.includes("location_conflict")) {
    findings.push(makeFinding("LOCATION_CONFLICT", candidateIds, ["birthRecord.location"]));
  }
  if (classifyUnknownBirthplaceBasis(input.birthRecord) === "valid_basis") {
    findings.push(makeFinding(
      "LOCATION_COORDINATE_UNKNOWN",
      candidateIds,
      ["birthRecord.location", "birthRecord.policy.trueSolar"]
    ));
  }
  if (
    input.provenanceFlags.includes("clock_convention_unresolved")
    || input.birthRecord.location.clockConvention === "unknown"
  ) {
    findings.push(makeFinding(
      "CLOCK_CONVENTION_UNRESOLVED",
      candidateIds,
      ["birthRecord.location.clockConvention"]
    ));
  }
  if (input.provenanceFlags.includes("xinjiang_clock_convention_unresolved")) {
    findings.push(makeFinding(
      "XINJIANG_CLOCK_CONVENTION_UNRESOLVED",
      candidateIds,
      ["birthRecord.location.clockConvention"]
    ));
  }
  if (input.provenanceFlags.includes("dual_track_source_mismatch")) {
    findings.push(makeFinding("DUAL_TRACK_SOURCE_MISMATCH", candidateIds, ["chartBundles"]));
  }
  if (input.provenanceFlags.includes("representative_coordinate")) {
    const coordinateProof = input.uncertaintyProofs.find((proof) => proof.kind === "representative_coordinate");
    const coordinateReplay = coordinateProof === undefined
      ? { valid: false, sameDualChart: false }
      : replayCoverageSamples(input, coordinateProof.samples, "representative_coordinate");
    const coordinateProofValid = coordinateProof !== undefined
      && coordinateProof.sourceRecordFingerprint === sourceFingerprint
      && new Set(coordinateProof.samples.map((sample) => sample.longitude).filter((value) => value !== undefined)).size >= 2
      && coordinateProof.samples.every((sample) => candidateIds.includes(sample.candidateId))
      && coordinateReplay.valid
      && coordinateReplay.sameDualChart;
    findings.push(makeFinding(
      coordinateProofValid
        ? "REPRESENTATIVE_COORDINATE_SAME_CHART"
        : "REPRESENTATIVE_COORDINATE_MATERIAL",
      candidateIds,
      ["birthRecord.location.longitude"]
    ));
  }
  if (input.provenanceFlags.includes("leap_month_unresolved")) {
    const calendarProof = input.uncertaintyProofs.find((proof) => proof.kind === "leap_month");
    const calendarReplay = calendarProof === undefined
      ? { valid: false, sameDualChart: false }
      : replayCoverageSamples(input, calendarProof.samples, "leap_month");
    const calendarProofValid = calendarProof !== undefined
      && calendarProof.sourceRecordFingerprint === sourceFingerprint
      && new Set(calendarProof.samples.map((sample) => sample.calendarKey).filter((value) => value !== undefined)).size >= 2
      && calendarProof.samples.every((sample) => candidateIds.includes(sample.candidateId))
      && calendarReplay.valid;
    if (!input.provenanceFlags.includes("calendar_candidates_complete") || !calendarProofValid || !state.allComplete) {
      findings.push(makeFinding("LEAP_MONTH_EVIDENCE_INCOMPLETE", candidateIds, ["birthRecord.calendar"]));
    } else {
      findings.push(makeFinding(
        calendarReplay.sameDualChart
          ? "LEAP_MONTH_CANDIDATES_SAME_CHART"
          : "LEAP_MONTH_CANDIDATES_MATERIAL",
        candidateIds,
        ["birthRecord.calendar"]
      ));
    }
  }
  if (input.provenanceFlags.some((flag) => !KNOWN_PROVENANCE_FLAGS.has(flag))) {
    findings.push(makeFinding("UNKNOWN_PROVENANCE_FLAG", candidateIds, ["provenanceFlags"]));
  }

  const rawTimeCandidateIds = input.timeEvidence.candidates.map((candidate) => candidate.id);
  const rawChartCandidateIds = input.chartBundles.map((bundle) => bundle.candidateId);
  const chartCandidateIds = sortedUnique(rawChartCandidateIds);
  const candidateSetsMatch = candidateIds.length === chartCandidateIds.length
    && candidateIds.every((candidateId, index) => candidateId === chartCandidateIds[index])
    && rawTimeCandidateIds.length === candidateIds.length
    && rawChartCandidateIds.length === chartCandidateIds.length;
  if (
    input.birthRecord.caseId !== input.timeEvidence.caseId
    || input.chartSet.caseId !== input.birthRecord.caseId
    || !candidateSetsMatch
  ) {
    findings.push(makeFinding(
      "CASE_REVISION_OR_CANDIDATE_MISMATCH",
      candidateIds,
      [`chartCandidateIds:${chartCandidateIds.join(",")}`]
    ));
  }

  const byCandidateId = new Map(input.chartBundles.map((bundle) => [bundle.candidateId, bundle]));
  const matchingBundles = candidateIds
    .map((candidateId) => byCandidateId.get(candidateId))
    .filter((bundle): bundle is AuditableChartBundleV1 => bundle !== undefined);
  const completeBundles = matchingBundles.filter((bundle) => (
    trackIsUsable(bundle, "bazi") && trackIsUsable(bundle, "ziwei")
  ));
  const engineFailureBundles = matchingBundles.filter((bundle) => (
    isTrackFailure(bundle.bazi) || isTrackFailure(bundle.ziwei)
  ));
  const anyUsableTrack = matchingBundles.some((bundle) => (
    trackIsUsable(bundle, "bazi") || trackIsUsable(bundle, "ziwei")
  ));
  if (completeBundles.length === 0 && !anyUsableTrack) {
    findings.push(makeFinding("NO_COMPLETE_DUAL_CHART", candidateIds));
  } else if (completeBundles.length < candidateIds.length) {
    findings.push(makeFinding(
      "CANDIDATE_CHART_INCOMPLETE",
      candidateIds.filter((candidateId) => {
        const bundle = byCandidateId.get(candidateId);
        return bundle === undefined || !trackIsUsable(bundle, "bazi") || !trackIsUsable(bundle, "ziwei");
      })
    ));
  }
  if (engineFailureBundles.length > 0) {
    findings.push(makeFinding(
      anyUsableTrack ? "ENGINE_PARTIAL_FAILURE" : "ENGINE_TOTAL_FAILURE",
      engineFailureBundles.map((bundle) => bundle.candidateId)
    ));
  }
  if (
    input.manualDecision.status === "selected"
    && (() => {
      const selected = byCandidateId.get(input.manualDecision.selectedCandidateId);
      return selected === undefined || !trackIsUsable(selected, "bazi") || !trackIsUsable(selected, "ziwei");
    })()
  ) {
    findings.push(makeFinding(
      "SELECTED_CANDIDATE_INCOMPLETE",
      [input.manualDecision.selectedCandidateId],
      ["manualDecision.selectedCandidateId"]
    ));
  }

  if (candidateIds.length > 1 && state.allComplete) {
    if (state.sameDualChart) {
      findings.push(makeFinding("CANDIDATES_SAME_DUAL_CHART", candidateIds));
    } else {
      findings.push(makeFinding(
        input.manualDecision.status === "selected"
          ? "CANDIDATE_DIVERGENCE_MANUALLY_SELECTED"
          : "CANDIDATE_DIVERGENCE_UNRESOLVED",
        candidateIds
      ));
    }
  }

  const timeCandidateById = new Map(input.timeEvidence.candidates.map((candidate) => [candidate.id, candidate]));
  const sourceMismatchIds: string[] = [];
  const embeddedEngineMismatchIds: string[] = [];
  const embeddedRulesetMismatchIds: string[] = [];
  for (const bundle of matchingBundles) {
    const candidate = timeCandidateById.get(bundle.candidateId);
    const expectedSourceLocalDateTime = candidate === undefined
      ? null
      : candidate.ziSegment === "late" && candidate.dayBoundary === "forward"
        ? LocalDateTime.parse(candidate.localDateTime).minusDays(1).toString()
        : candidate.localDateTime;
    let sourceMismatch = candidate === undefined
      || bundle.basis !== candidate.basis
      || bundle.dayBoundary !== candidate.dayBoundary
      || bundle.calendarResolutionId !== candidate.calendarResolutionId
      || bundle.calendarBasis !== candidate.calendarBasis;
    if (!isTrackFailure(bundle.bazi) && candidate !== undefined) {
      sourceMismatch ||= bundle.bazi.candidateId !== bundle.candidateId
        || bundle.bazi.input.sourceLocalDateTime !== expectedSourceLocalDateTime
        || bundle.bazi.input.calculationLocalDateTime !== candidate.localDateTime
        || bundle.bazi.input.timeBasis !== candidate.basis
        || bundle.bazi.input.earthlyBranchIndex !== candidate.earthlyBranch.index
        || bundle.bazi.configuration.sourceDayBoundary !== candidate.dayBoundary
        || bundle.bazi.calendar.solarDate !== expectedSourceLocalDateTime?.slice(0, 10);
      if (
        bundle.bazi.engine.name !== AUDIT_EXPECTED_VERSION_EVIDENCE.lunarEngine.name
        || bundle.bazi.engine.version !== AUDIT_EXPECTED_VERSION_EVIDENCE.lunarEngine.version
        || canonicalString(jsonValue(bundle.bazi.engine)) !== canonicalString(jsonValue(input.chartSet.engineVersions.bazi))
      ) embeddedEngineMismatchIds.push(bundle.candidateId);
      const expectedPillarSect = candidate.ziSegment === "late" && candidate.dayBoundary === "forward" ? 1 : 2;
      if (
        bundle.bazi.rulesetVersion !== AUDIT_EXPECTED_VERSION_EVIDENCE.baziRuleset
        || bundle.bazi.configuration.pillarSect !== expectedPillarSect
        || bundle.bazi.configuration.luckSect !== 1
        || bundle.bazi.configuration.yearBoundary !== "li_chun"
        || bundle.bazi.configuration.monthBoundary !== "solar_terms"
      ) embeddedRulesetMismatchIds.push(bundle.candidateId);
      const actualYears = sortedUnique(bundle.bazi.annualFortunes.map((fortune) => String(fortune.year))).map(Number);
      const expectedYears = [...input.chartSet.targetYears].sort((left, right) => left - right);
      if (canonicalString(jsonValue(actualYears)) !== canonicalString(jsonValue(expectedYears))) {
        sourceMismatch = true;
      }
    }
    if (!isTrackFailure(bundle.ziwei) && candidate !== undefined) {
      const expectedSourceTimeIndex = candidate.ziSegment === "late" ? 12 : candidate.earthlyBranch.index;
      const expectedTimeIndex = candidate.ziSegment === "late" && candidate.dayBoundary === "forward"
        ? 0
        : expectedSourceTimeIndex;
      sourceMismatch ||= bundle.ziwei.candidateId !== bundle.candidateId
        || bundle.ziwei.input.sourceLocalDateTime !== expectedSourceLocalDateTime
        || bundle.ziwei.input.calculationLocalDateTime !== candidate.localDateTime
        || bundle.ziwei.input.timeBasis !== candidate.basis
        || bundle.ziwei.input.sourceZiSegment !== candidate.ziSegment
        || bundle.ziwei.input.sourceDayBoundary !== candidate.dayBoundary
        || bundle.ziwei.input.engineInputDate !== candidate.localDateTime.slice(0, 10)
        || bundle.ziwei.configuration.sourceTimeIndex !== expectedSourceTimeIndex
        || bundle.ziwei.configuration.timeIndex !== expectedTimeIndex
        || bundle.ziwei.solarDate !== candidate.localDateTime.slice(0, 10)
        || bundle.ziwei.gender !== input.birthRecord.gender;
      if (
        bundle.ziwei.engine.name !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiEngine.name
        || bundle.ziwei.engine.version !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiEngine.version
        || canonicalString(jsonValue(bundle.ziwei.engine)) !== canonicalString(jsonValue(input.chartSet.engineVersions.ziwei))
      ) embeddedEngineMismatchIds.push(bundle.candidateId);
      if (
        bundle.ziwei.rulesetVersion !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiRuleset
        || bundle.ziwei.configuration.algorithm !== "default"
        || bundle.ziwei.configuration.yearDivide !== "normal"
        || bundle.ziwei.configuration.horoscopeDivide !== "normal"
        || bundle.ziwei.configuration.ageDivide !== "normal"
        || bundle.ziwei.configuration.dayDivide !== "current"
        || bundle.ziwei.configuration.mutagens !== "iztro-2.5.8-default"
        || bundle.ziwei.configuration.brightness !== "iztro-2.5.8-default"
        || bundle.ziwei.configuration.astroType !== "heaven"
        || bundle.ziwei.configuration.fixLeap !== true
        || bundle.ziwei.configuration.language !== "zh-CN"
      ) embeddedRulesetMismatchIds.push(bundle.candidateId);
      const actualYears = sortedUnique(bundle.ziwei.yearlyFortunes.map((fortune) => String(fortune.targetYear))).map(Number);
      const expectedYears = [...input.chartSet.targetYears].sort((left, right) => left - right);
      if (canonicalString(jsonValue(actualYears)) !== canonicalString(jsonValue(expectedYears))) {
        sourceMismatch = true;
      }
    }
    if (sourceMismatch) sourceMismatchIds.push(bundle.candidateId);
  }
  if (sourceMismatchIds.length > 0) {
    findings.push(makeFinding("DUAL_TRACK_SOURCE_MISMATCH", sourceMismatchIds, ["chartSet.candidates"]));
  }

  const engineMismatch = input.versionEvidence === null
    || input.versionEvidence.lunarEngine.name !== AUDIT_EXPECTED_VERSION_EVIDENCE.lunarEngine.name
    || input.versionEvidence.lunarEngine.version !== AUDIT_EXPECTED_VERSION_EVIDENCE.lunarEngine.version
    || input.versionEvidence.ziweiEngine.name !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiEngine.name
    || input.versionEvidence.ziweiEngine.version !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiEngine.version
    || embeddedEngineMismatchIds.length > 0;
  if (engineMismatch) {
    findings.push(makeFinding("ENGINE_VERSION_UNAPPROVED", embeddedEngineMismatchIds, ["chartSet.engineVersions"]));
  }
  const rulesetMismatch = input.versionEvidence === null
    || input.versionEvidence.auditRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.auditRuleset
    || input.versionEvidence.timeRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.timeRuleset
    || input.versionEvidence.baziRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.baziRuleset
    || input.versionEvidence.ziweiRuleset !== AUDIT_EXPECTED_VERSION_EVIDENCE.ziweiRuleset
    || input.chartSet.timeRulesetVersion !== input.timeEvidence.rulesetVersion
    || embeddedRulesetMismatchIds.length > 0
    || canonicalString(jsonValue(input.versionEvidence.xinjiangLocationRule ?? null))
      !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.xinjiangLocationRule))
    || (
      input.versionEvidence.unknownBirthplaceRule !== undefined
      && canonicalString(jsonValue(input.versionEvidence.unknownBirthplaceRule))
        !== canonicalString(jsonValue(AUDIT_EXPECTED_VERSION_EVIDENCE.unknownBirthplaceRule))
    )
    || canonicalString(jsonValue(input.versionEvidence.ruleSnapshotSha256 ?? null)) !== canonicalString(jsonValue(RULE_SNAPSHOT_HASHES));
  if (rulesetMismatch) {
    findings.push(makeFinding("RULESET_VERSION_UNAPPROVED", embeddedRulesetMismatchIds, [
      "chartSet.chartRulesetVersions",
      "versionEvidence.xinjiangLocationRule",
      "versionEvidence.unknownBirthplaceRule",
      "versionEvidence.ruleSnapshotSha256"
    ]));
  }
  if (
    input.versionEvidence === null
    || canonicalString(input.versionEvidence.timezoneEngine) !== canonicalString(AUDIT_EXPECTED_VERSION_EVIDENCE.timezoneEngine)
  ) {
    findings.push(makeFinding("TIMEZONE_MANIFEST_MISMATCH", [], ["versionEvidence.timezoneEngine"]));
  }
  if (input.storedContentFingerprint !== undefined && input.storedContentFingerprint !== fingerprint.value) {
    findings.push(makeFinding("CONTENT_FINGERPRINT_MISMATCH", [], ["storedContentFingerprint"]));
  }

  const candidateIdSet = new Set(candidateIds);
  input.timeEvidence.issues.forEach((issue) => {
    const referencedIds = sortedUnique(issue.candidateIds);
    const evidenceRef = [`timeEvidence.issue:${issue.code}:${referencedIds.join(",")}`];
    if (referencedIds.some((candidateId) => !candidateIdSet.has(candidateId))) {
      findings.push(makeFinding(
        "CANDIDATE_REFERENCE_INVALID",
        referencedIds.filter((candidateId) => candidateIdSet.has(candidateId)),
        evidenceRef
      ));
      return;
    }
    if (!isKnownTimeIssueCode(issue.code)) {
      findings.push(makeFinding("UNKNOWN_TIME_ISSUE_CODE", referencedIds, evidenceRef));
      return;
    }
    const definition = TIME_ISSUE_DEFINITIONS[issue.code];
    if (issue.severity !== definition.severity) {
      findings.push(makeFinding("TIME_ISSUE_SEVERITY_INVALID", referencedIds, evidenceRef));
      return;
    }
    if (referencedIds.length < definition.minimumCandidates) {
      findings.push(makeFinding("TIME_EVIDENCE_INCOMPLETE", referencedIds, evidenceRef));
      return;
    }

    const issueMaterial = materialState(input, referencedIds);
    let findingCode: AuditFindingCodeV1;
    switch (issue.code) {
      case "dst_overlap":
        findingCode = issueMaterial.sameDualChart
          ? "TIME_DST_OVERLAP_SAME_CHART"
          : "TIME_DST_OVERLAP_MATERIAL";
        break;
      case "dst_gap":
        findingCode = "TIME_DST_GAP";
        break;
      case "dst_unknown":
        findingCode = issueMaterial.sameDualChart
          ? "TIME_DST_UNKNOWN_SAME_CHART"
          : "TIME_DST_UNKNOWN_MATERIAL";
        break;
      case "true_solar_branch_change":
        findingCode = "TIME_TRUE_SOLAR_BRANCH_CHANGE";
        break;
      case "true_solar_same_branch":
        findingCode = issueMaterial.sameDualChart
          ? "TIME_TRUE_SOLAR_SAME_CHART"
          : "TIME_TRUE_SOLAR_MATERIAL";
        break;
      case "late_zi_ambiguity":
        findingCode = issueMaterial.sameDualChart
          ? "TIME_LATE_ZI_SAME_CHART"
          : "TIME_LATE_ZI_MATERIAL";
        break;
      case "leap_month_ambiguity":
        findingCode = "TIME_LEAP_MONTH_UNRESOLVED";
        break;
      case "leap_month_alternative_invalid":
        findingCode = "TIME_LEAP_MONTH_ALTERNATIVE_INVALID";
        break;
      case "historical_uncertainty":
        findingCode = "TIME_HISTORICAL_UNCERTAINTY";
        break;
      case "future_provisional":
        findingCode = "TIME_FUTURE_PROVISIONAL";
        break;
      case "standard_offset_unresolved":
        findingCode = "TIME_STANDARD_OFFSET_UNRESOLVED";
        break;
    }
    findings.push(makeFinding(findingCode, referencedIds, evidenceRef));
  });

  const normalizedFindings = materializeFindings(findings);
  const auditLevel = maxAuditLevel(normalizedFindings);
  const blockingReasons: AuditReportV1["blockingReasons"] = normalizedFindings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => ({
      code: finding.code,
      source: "audit",
      levelImpact: finding.levelImpact === "C" || finding.levelImpact === "D" ? finding.levelImpact : null,
      candidateIds: finding.candidateIds,
      summary: finding.summary
    }));
  if (input.workflowStatus === "void") {
    blockingReasons.push({
      code: "WORKFLOW_VOID",
      source: "workflow",
      levelImpact: null,
      candidateIds: [],
      summary: "当前修订已作废，禁止用于任何分析"
    });
  }

  return AuditReportV1Schema.parse({
    schemaVersion: "1.0.0",
    auditReportId: input.auditReportId,
    caseId: input.birthRecord.caseId,
    revisionId: input.revisionId,
    candidateIds,
    rulesetVersion: "CyberSaga-Audit-v1",
    engineVersions: input.versionEvidence,
    auditLevel,
    workflowStatus: input.workflowStatus,
    findings: normalizedFindings,
    blockingReasons,
    allowedAnalysisModes: allowedModes(auditLevel, input.workflowStatus, state),
    manualDecision: normalizeManualDecision(input.manualDecision),
    contentFingerprint: fingerprint
  });
}

function providedTimeMaterialState(
  input: ParsedAuditInputV2,
  selectedCandidateIds?: readonly string[]
): MaterialState {
  const expectedIds = sortedUnique(selectedCandidateIds ?? input.timeEvidence.candidates.map((candidate) => candidate.id));
  const byId = new Map(input.chartSet.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const candidates = expectedIds.map((candidateId) => byId.get(candidateId));
  const allBazi = candidates.every((candidate) => candidate !== undefined && !isTrackFailure(candidate.bazi));
  const allZiwei = candidates.every((candidate) => candidate !== undefined && !isTrackFailure(candidate.ziwei));
  const baziHashes = new Set(candidates.flatMap((candidate) => (
    candidate !== undefined && !isTrackFailure(candidate.bazi) ? [materialHash(candidate.bazi, "bazi")] : []
  )));
  const ziweiHashes = new Set(candidates.flatMap((candidate) => (
    candidate !== undefined && !isTrackFailure(candidate.ziwei) ? [materialHash(candidate.ziwei, "ziwei")] : []
  )));
  const sameBazi = allBazi && baziHashes.size === 1;
  const sameZiwei = allZiwei && ziweiHashes.size === 1;
  return {
    allComplete: allBazi && allZiwei,
    sameBazi,
    sameZiwei,
    sameDualChart: sameBazi && sameZiwei
  };
}

function buildProvidedTimeAuditReport(rawInput: unknown): AuditReportV1 {
  const input = AuditInputV2Schema.parse(rawInput);
  const candidateIds = sortedUnique(input.timeEvidence.candidates.map((candidate) => candidate.id));
  const state = providedTimeMaterialState(input);
  const fingerprint = providedTimeContentFingerprint(input);
  const findings: FindingAccumulator[] = [];

  const sourceFingerprint = sourceRecordFingerprint(input.birthRecord);
  if (input.timeEvidence.sourceRecordFingerprint !== sourceFingerprint) {
    findings.push(makeFinding("SOURCE_RECORD_FINGERPRINT_MISMATCH", candidateIds, ["timeEvidence.sourceRecordFingerprint"]));
  }

  let evidenceReplayMatches = false;
  let chartReplayMatches = false;
  try {
    const replayedEvidence = normalizeProvidedTime(input.birthRecord);
    evidenceReplayMatches = canonicalString(jsonValue(replayedEvidence)) === canonicalString(jsonValue(input.timeEvidence));
    const replayedCharts = DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
      input.birthRecord,
      replayedEvidence,
      { targetYears: input.chartSet.targetYears }
    ));
    chartReplayMatches = successfulTracksMatchReplay(input.chartSet, replayedCharts)
      && successfulTracksMatchReplay(replayedCharts, input.chartSet);
  } catch {
    evidenceReplayMatches = false;
    chartReplayMatches = false;
  }
  if (!evidenceReplayMatches) {
    findings.push(makeFinding("TIME_EVIDENCE_REPLAY_MISMATCH", candidateIds, ["birthRecord", "timeEvidence"]));
  }
  if (!chartReplayMatches) {
    findings.push(makeFinding("CHART_ENGINE_REPLAY_MISMATCH", candidateIds, ["chartSet.engineReplay"]));
  }

  const rawChartIds = input.chartSet.candidates.map((candidate) => candidate.candidateId);
  const chartIds = sortedUnique(rawChartIds);
  if (
    input.birthRecord.caseId !== input.timeEvidence.caseId
    || input.chartSet.caseId !== input.birthRecord.caseId
    || candidateIds.length !== chartIds.length
    || rawChartIds.length !== chartIds.length
    || candidateIds.some((candidateId, index) => candidateId !== chartIds[index])
  ) {
    findings.push(makeFinding("CASE_REVISION_OR_CANDIDATE_MISMATCH", candidateIds, ["chartSet.candidates"]));
  }

  const incompleteIds = input.chartSet.candidates.filter((candidate) => (
    isTrackFailure(candidate.bazi) || isTrackFailure(candidate.ziwei)
  )).map((candidate) => candidate.candidateId);
  if (!state.allComplete) {
    findings.push(makeFinding(
      incompleteIds.length === input.chartSet.candidates.length ? "ENGINE_TOTAL_FAILURE" : "ENGINE_PARTIAL_FAILURE",
      incompleteIds
    ));
  }
  if (input.manualDecision.status === "selected" && incompleteIds.includes(input.manualDecision.selectedCandidateId)) {
    findings.push(makeFinding("SELECTED_CANDIDATE_INCOMPLETE", [input.manualDecision.selectedCandidateId]));
  }

  const expectedFlags = [
    input.birthRecord.providedTime.basis === "apparent_solar_provided"
      ? "provided_time_apparent_solar"
      : "provided_time_civil_clock",
    ...(input.privateMetadataPresence.providedTimeSourceNote ? ["provided_time_source_note_present"] : [])
  ];
  if (
    canonicalString(jsonValue(sortedUnique(input.provenanceFlags)))
      !== canonicalString(jsonValue(sortedUnique(expectedFlags)))
  ) {
    findings.push(makeFinding("UNKNOWN_PROVENANCE_FLAG", candidateIds, ["provenanceFlags"]));
  }

  const versionAssessment = assessAuditVersionEvidence(input.versionEvidence);
  for (const code of versionAssessment.requiredBlockerCodes) {
    findings.push(makeFinding(code, [], ["versionEvidence"]));
  }

  switch (input.birthRecord.providedTime.precision) {
    case "minute":
      if (!input.precisionCoverage.complete || !state.allComplete) {
        findings.push(makeFinding("PRECISION_MINUTE_UNRESOLVED", input.precisionCoverage.candidateIds));
      }
      break;
    case "approximate":
      findings.push(makeFinding(
        input.precisionCoverage.complete && state.sameDualChart
          ? "PRECISION_APPROXIMATE_SAME_CHART"
          : "PRECISION_APPROXIMATE_UNRESOLVED",
        input.precisionCoverage.candidateIds
      ));
      break;
    case "branch":
      findings.push(makeFinding(
        input.precisionCoverage.complete && state.sameDualChart
          ? "PRECISION_BRANCH_SAME_CHART"
          : "PRECISION_BRANCH_UNRESOLVED",
        input.precisionCoverage.candidateIds
      ));
      break;
  }

  const candidateIdSet = new Set(candidateIds);
  for (const issue of input.timeEvidence.issues) {
    const referencedIds = sortedUnique(issue.candidateIds);
    const evidenceRefs = [`timeEvidence.issue:${issue.code}:${referencedIds.join(",")}`];
    if (referencedIds.some((candidateId) => !candidateIdSet.has(candidateId))) {
      findings.push(makeFinding("CANDIDATE_REFERENCE_INVALID", [], evidenceRefs));
      continue;
    }
    const definition = TIME_ISSUE_DEFINITIONS[issue.code];
    if (issue.severity !== definition.severity || referencedIds.length < definition.minimumCandidates) {
      findings.push(makeFinding(
        issue.severity !== definition.severity ? "TIME_ISSUE_SEVERITY_INVALID" : "TIME_EVIDENCE_INCOMPLETE",
        referencedIds,
        evidenceRefs
      ));
      continue;
    }
    const issueState = providedTimeMaterialState(input, referencedIds);
    const findingCode: AuditFindingCodeV1 = issue.code === "late_zi_ambiguity"
      ? (issueState.sameDualChart ? "TIME_LATE_ZI_SAME_CHART" : "TIME_LATE_ZI_MATERIAL")
      : issue.code === "leap_month_ambiguity"
        ? "TIME_LEAP_MONTH_UNRESOLVED"
        : "TIME_LEAP_MONTH_ALTERNATIVE_INVALID";
    findings.push(makeFinding(findingCode, referencedIds, evidenceRefs));
  }

  if (input.storedContentFingerprint !== undefined && input.storedContentFingerprint !== fingerprint.value) {
    findings.push(makeFinding("CONTENT_FINGERPRINT_MISMATCH", [], ["storedContentFingerprint"]));
  }

  const normalizedFindings = materializeFindings(findings);
  const auditLevel = maxAuditLevel(normalizedFindings);
  const blockingReasons: AuditReportV1["blockingReasons"] = normalizedFindings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => ({
      code: finding.code,
      source: "audit",
      levelImpact: finding.levelImpact === "C" || finding.levelImpact === "D" ? finding.levelImpact : null,
      candidateIds: finding.candidateIds,
      summary: finding.summary
    }));
  if (input.workflowStatus === "void") {
    blockingReasons.push({
      code: "WORKFLOW_VOID",
      source: "workflow",
      levelImpact: null,
      candidateIds: [],
      summary: "当前修订已作废，禁止用于任何分析"
    });
  }
  const boundary = PROVIDED_TIME_PRESENTATION[input.birthRecord.providedTime.basis];
  return AuditReportV1Schema.parse({
    schemaVersion: "1.0.0",
    auditReportId: input.auditReportId,
    caseId: input.birthRecord.caseId,
    revisionId: input.revisionId,
    candidateIds,
    rulesetVersion: "CyberSaga-Audit-v1",
    engineVersions: input.versionEvidence,
    provenanceFlags: sortedUnique(input.provenanceFlags),
    timeInputBoundary: {
      basis: input.birthRecord.providedTime.basis,
      assertionCode: boundary.assertionCode
    },
    auditLevel,
    workflowStatus: input.workflowStatus,
    findings: normalizedFindings,
    blockingReasons,
    allowedAnalysisModes: allowedModes(auditLevel, input.workflowStatus, state),
    manualDecision: normalizeManualDecision(input.manualDecision),
    contentFingerprint: fingerprint
  });
}

export function buildAuditReport(rawInput: unknown): AuditReportV1 {
  const record = typeof rawInput === "object" && rawInput !== null && "birthRecord" in rawInput
    ? (rawInput as { birthRecord?: unknown }).birthRecord
    : null;
  if (typeof record === "object" && record !== null && "schemaVersion" in record
    && (record as { schemaVersion?: unknown }).schemaVersion === "2.0.0") {
    return buildProvidedTimeAuditReport(rawInput);
  }
  return buildHistoricalAuditReport(rawInput);
}

export interface BuildDetailedAuditReportInput {
  auditInput: AuditInputV2;
  baziDetail: unknown;
}

export function buildDetailedAuditReport(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  raw: BuildDetailedAuditReportInput
): AuditReportV2 {
  if (marker !== AUDIT_CONTRACT_VERSION_V4) throw new TypeError("V4_AUDIT_MARKER_REQUIRED");
  const input = AuditInputV2Schema.parse(raw.auditInput);
  const { storedContentFingerprint: _storedContentFingerprint, ...v3CompatibleInputWithoutStoredFingerprint } = input;
  const base = buildAuditReport(v3CompatibleInputWithoutStoredFingerprint);
  const baziDetail = parseBoundBaziDetail({
    publicBirthRecord: input.birthRecord,
    timeEvidence: input.timeEvidence,
    baseChartSet: input.chartSet as unknown as DualTrackChartSetV1,
    detail: raw.baziDetail
  });
  const versionEvidence = deriveVersionEvidenceV3(marker, input.chartSet, input.timeEvidence);
  const boundary = PROVIDED_TIME_PRESENTATION[input.birthRecord.providedTime.basis];
  const contentFingerprint = computeAuditContentFingerprintV2(marker, {
    birthRecord: jsonValue(input.birthRecord),
    timeEvidence: jsonValue(input.timeEvidence),
    chartSet: normalizedChartSetProjection(input.chartSet),
    baziDetail,
    versionEvidence: jsonValue(versionEvidence),
    timeInputBoundary: jsonValue({
      basis: input.birthRecord.providedTime.basis,
      assertionCode: boundary.assertionCode
    }),
    provenanceFlags: jsonValue(sortedUnique(input.provenanceFlags)),
    precisionCoverage: jsonValue({
      ...input.precisionCoverage,
      candidateIds: sortedUnique(input.precisionCoverage.candidateIds),
      proof: input.precisionCoverage.proof === null
        ? null
        : normalizedCoverageProof(input.precisionCoverage.proof)
    }),
    artifactManifest: jsonValue({
      artifacts: [...input.artifactManifest.artifacts].sort((left, right) => (
        compareText(left.artifactId, right.artifactId) || compareText(left.sha256, right.sha256)
      ))
    }),
    manualDecision: jsonValue(normalizeManualDecision(input.manualDecision))
  });
  return AuditReportV2Schema.parse({
    ...base,
    schemaVersion: "2.0.0",
    rulesetVersion: "CyberSaga-Audit-v2",
    engineVersions: versionEvidence,
    contentFingerprint
  });
}

const DiagnosticEnvelopeV1Schema = z.object({
  auditReportId: z.string().min(1),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  revisionId: z.string().regex(/^R\d{3}$/u),
  workflowStatus: z.enum(["draft", "review", "verified", "void"])
}).strict();

export function buildAuditDiagnosticReport(raw: {
  envelope: z.input<typeof DiagnosticEnvelopeV1Schema>;
  rawInput: unknown;
  contentHashesMatch?: boolean;
}): AuditReportV1 {
  const envelope = DiagnosticEnvelopeV1Schema.parse(raw.envelope);
  const schemaValid = AuditInputV1Schema.safeParse(raw.rawInput).success;
  const diagnosticFindings = [
    ...(!schemaValid ? [makeFinding("ARTIFACT_SCHEMA_INVALID", [], ["rawInput"])] : []),
    ...(raw.contentHashesMatch === false
      ? [makeFinding("ARTIFACT_CONTENT_MISMATCH", [], ["caseManifest"])]
      : [])
  ];
  if (diagnosticFindings.length === 0) {
    throw new Error("DIAGNOSTIC_REPORT_REQUIRES_A_SCHEMA_OR_CONTENT_FAILURE");
  }
  const findings = materializeFindings(diagnosticFindings);
  const blockingReasons: AuditReportV1["blockingReasons"] = findings.map((finding) => ({
    code: finding.code,
    source: "audit",
    levelImpact: "D",
    candidateIds: [],
    summary: finding.summary
  }));
  if (envelope.workflowStatus === "void") {
    blockingReasons.push({
      code: "WORKFLOW_VOID",
      source: "workflow",
      levelImpact: null,
      candidateIds: [],
      summary: "当前修订已作废，禁止用于任何分析"
    });
  }
  let diagnosticMaterial: JsonValue;
  try {
    diagnosticMaterial = jsonValue(raw.rawInput);
  } catch {
    diagnosticMaterial = { unrepresentable: true };
  }
  return AuditReportV1Schema.parse({
    schemaVersion: "1.0.0",
    auditReportId: envelope.auditReportId,
    caseId: envelope.caseId,
    revisionId: envelope.revisionId,
    candidateIds: [],
    rulesetVersion: "CyberSaga-Audit-v1",
    engineVersions: AUDIT_EXPECTED_VERSION_EVIDENCE,
    auditLevel: "D",
    workflowStatus: envelope.workflowStatus,
    findings,
    blockingReasons,
    allowedAnalysisModes: envelope.workflowStatus === "void" ? [] : ["data_diagnosis"],
    manualDecision: {
      status: "none",
      selectedCandidateId: null,
      rationale: null,
      decidedAt: null,
      decidedBy: null,
      evidenceRefs: []
    },
    contentFingerprint: {
      algorithm: "sha256",
      canonicalization: "json-canonicalize@2.0.0",
      scope: "birth-time-charts-rules-manual-v1",
      value: sha256(canonicalString(diagnosticMaterial))
    }
  });
}
