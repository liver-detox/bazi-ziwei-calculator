import { canonicalize } from "json-canonicalize";
import { z } from "zod";

import {
  AuditReportV1Schema,
  AuditReportV2Schema,
  type AuditReportV1,
  type AuditReportV2,
  type VersionedAuditReport
} from "../audit/index.js";
import {
  ReviewRevisionIdSchema,
  Rfc3339SecondSchema,
  Sha256FingerprintSchema,
  compareUnicodeCodePoints
} from "./contracts/common.js";
import {
  FieldComparisonV1Schema,
  FieldComparisonV2Schema,
  type FieldComparison,
  type FieldComparisonRowV1,
  type FieldComparisonV1,
  type FieldComparisonV2
} from "./contracts/field-comparison.js";
import {
  HumanDecisionV1Schema,
  HumanVerificationV1Schema,
  HumanVerificationV2Schema,
  type HumanDecisionV1,
  type HumanVerification,
  type HumanVerificationV1,
  type HumanVerificationV2
} from "./contracts/human-verification.js";
import {
  ReferenceEvidenceV1Schema,
  type ReferenceClaimV1,
  type ReferenceEvidenceV1,
  type ReferenceSourceV1
} from "./contracts/reference-evidence.js";
import { ReviewError } from "./errors.js";
import { computeVerificationFingerprint } from "./fingerprints.js";
import type { ReviewSubjectV3 } from "./subject-revision.js";
import {
  referenceRegistryIdentityForFingerprint,
  requiredKeysetPathsForVersion,
  type ReferenceKeysetGroup
} from "./registry.js";

export interface BuildHumanVerificationInput {
  reviewRevisionId: string;
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
  audit: VersionedAuditReport;
  decisions: HumanDecisionV1[];
  previousVerificationFingerprint?: string;
  recordedAt: string;
  verifiedAt: string | null;
}

export interface ReferenceCoverageResult {
  coverageStatus: "complete" | "partial" | "none";
  missing: Array<{ candidateId: string; group: string; fieldPaths: string[] }>;
}

type VerificationStatus = HumanVerification["verificationStatus"];

type ValidatedArtifacts = {
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
  candidateIds: string[];
  claimById: Map<string, ReferenceClaimV1>;
  sourceById: Map<string, ReferenceSourceV1>;
};

type SnapshotJson =
  | null
  | string
  | boolean
  | number
  | SnapshotJson[]
  | { [key: string]: SnapshotJson };

// Audit bound: the largest legal 4-candidate × 50-target-year graph measured
// 18,157 nodes. 100,000 nodes leave >5× headroom while staying below 1,000,000.
const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 100_000;

type SnapshotState = {
  active: WeakSet<object>;
  nodes: number;
};

function snapshotArray(
  descriptors: PropertyDescriptorMap,
  state: SnapshotState,
  depth: number
): SnapshotJson[] {
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (descriptorKeys.some((key) => typeof key !== "string")) {
    throw new TypeError("array symbol key is not JSON data");
  }
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new TypeError("array length descriptor is invalid");
  }
  const length = lengthDescriptor.value;
  const indexKeys = descriptorKeys.filter((key): key is string => key !== "length") as string[];
  if (indexKeys.length !== length) throw new TypeError("sparse arrays are not JSON data");
  const result: SnapshotJson[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new TypeError("array entries must be enumerable data properties");
    }
    result.push(snapshotValue(descriptor.value, state, depth + 1));
  }
  return result;
}

function snapshotObject(
  prototype: object | null,
  descriptors: PropertyDescriptorMap,
  state: SnapshotState,
  depth: number
): { [key: string]: SnapshotJson } {
  const result = prototype === null
    ? Object.create(null) as { [key: string]: SnapshotJson }
    : {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") throw new TypeError("symbol keys are not JSON data");
    const descriptor = descriptors[key];
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError("objects must contain only enumerable data properties");
    }
    Object.defineProperty(result, key, {
      value: snapshotValue(descriptor.value, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return result;
}

function snapshotValue(value: unknown, state: SnapshotState, depth: number): SnapshotJson {
  if (depth > SNAPSHOT_MAX_DEPTH) throw new TypeError("JSON data exceeds the depth budget");
  state.nodes += 1;
  if (state.nodes > SNAPSHOT_MAX_NODES) throw new TypeError("JSON data exceeds the node budget");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not JSON data");
    return value;
  }
  if (typeof value !== "object") throw new TypeError("value is not JSON data");
  if (state.active.has(value)) throw new TypeError("cyclic values are not JSON data");
  state.active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError("custom array prototypes are not allowed");
      return snapshotArray(descriptors, state, depth);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("custom object prototypes are not allowed");
    }
    return snapshotObject(prototype, descriptors, state, depth);
  } finally {
    state.active.delete(value);
  }
}

function snapshotRuntimeInput(value: unknown): SnapshotJson {
  try {
    return snapshotValue(value, { active: new WeakSet<object>(), nodes: 0 }, 0);
  } catch {
    throw invalid("VERIFICATION_INPUT_INVALID", "签认领域输入形状无效");
  }
}

function runtimeObject<T extends object>(): z.ZodType<T> {
  return z.custom<T>((value) => value !== null && typeof value === "object" && !Array.isArray(value));
}

const DECISION_INPUT_KEYS = ["rowId", "disposition", "rationale", "evidenceRefs"] as const;

const RuntimeDecisionInputSchema = z.custom<HumanDecisionV1>((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== DECISION_INPUT_KEYS.length
    || ownKeys.some((key) => (
      typeof key !== "string" || !(DECISION_INPUT_KEYS as readonly string[]).includes(key)
    ))
  ) {
    return false;
  }
  const decision = value as Record<string, unknown>;
  return typeof decision.rowId === "string"
    && typeof decision.disposition === "string"
    && (decision.rationale === null || typeof decision.rationale === "string")
    && Array.isArray(decision.evidenceRefs)
    && decision.evidenceRefs.every((reference) => typeof reference === "string");
});

const BuildHumanVerificationInputSchema = z.object({
  reviewRevisionId: ReviewRevisionIdSchema,
  comparison: runtimeObject<FieldComparison>(),
  reference: runtimeObject<ReferenceEvidenceV1>(),
  audit: runtimeObject<VersionedAuditReport>(),
  decisions: z.array(RuntimeDecisionInputSchema),
  previousVerificationFingerprint: Sha256FingerprintSchema.optional(),
  recordedAt: Rfc3339SecondSchema,
  verifiedAt: Rfc3339SecondSchema.nullable()
}).strict().superRefine((value, context) => {
  if (
    Object.hasOwn(value, "previousVerificationFingerprint")
    && value.previousVerificationFingerprint === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "previousVerificationFingerprint 未使用时必须省略",
      path: ["previousVerificationFingerprint"]
    });
  }
}) as z.ZodType<BuildHumanVerificationInput>;

const ReferenceCoverageInputSchema = z.object({
  comparison: runtimeObject<FieldComparison>(),
  reference: runtimeObject<ReferenceEvidenceV1>()
}).strict();

const PilotReadinessV1InputSchema = z.object({
  audit: runtimeObject<AuditReportV1>(),
  comparison: runtimeObject<FieldComparisonV1>(),
  reference: runtimeObject<ReferenceEvidenceV1>(),
  verification: runtimeObject<HumanVerificationV1>(),
  fingerprintsCurrent: z.boolean()
}).strict();

const PilotReadinessV2InputSchema = z.object({
  subject: runtimeObject<ReviewSubjectV3>(),
  audit: runtimeObject<AuditReportV2>(),
  comparison: runtimeObject<FieldComparison>(),
  reference: runtimeObject<ReferenceEvidenceV1>(),
  verification: runtimeObject<HumanVerification>(),
  fingerprintsCurrent: z.boolean()
}).strict();

const PilotReadinessInputSchema = z.union([
  PilotReadinessV1InputSchema,
  PilotReadinessV2InputSchema
]);

const SupersededViewInputSchema = z.object({
  verification: runtimeObject<HumanVerification>(),
  hasSuccessorVerification: z.boolean(),
  subjectRevisionIsLatestDecision: z.boolean()
}).strict();

const BUILD_INPUT_KEYS = [
  "reviewRevisionId",
  "comparison",
  "reference",
  "audit",
  "decisions",
  "previousVerificationFingerprint",
  "recordedAt",
  "verifiedAt"
] as const;
const BUILD_REQUIRED_INPUT_KEYS = BUILD_INPUT_KEYS.filter(
  (key) => key !== "previousVerificationFingerprint"
);
const COVERAGE_INPUT_KEYS = ["comparison", "reference"] as const;
const READINESS_INPUT_KEYS = [
  "subject",
  "audit",
  "comparison",
  "reference",
  "verification",
  "fingerprintsCurrent"
] as const;
const READINESS_REQUIRED_INPUT_KEYS = READINESS_INPUT_KEYS.filter((key) => key !== "subject");
const SUPERSEDED_INPUT_KEYS = [
  "verification",
  "hasSuccessorVerification",
  "subjectRevisionIsLatestDecision"
] as const;

function invalid(code: string, message: string): ReviewError {
  return new ReviewError(code, message, 422);
}

function convertUnexpected<T>(
  action: () => T,
  code: string,
  message: string
): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw invalid(code, message);
  }
}

function parseRuntimeInput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys
): T {
  const snapshot = snapshotRuntimeInput(value);
  try {
    if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const allowed = new Set(allowedKeys);
      const ownKeys = Reflect.ownKeys(snapshot);
      if (
        ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
        || requiredKeys.some((key) => !ownKeys.includes(key))
      ) {
        throw new TypeError("unexpected input key");
      }
    }
    const parsed = schema.safeParse(snapshot);
    if (parsed.success) return parsed.data;
  } catch {
    // Runtime boundary failures intentionally collapse to one stable public error.
  }
  throw invalid("VERIFICATION_INPUT_INVALID", "签认领域输入形状无效");
}

function canonical(value: unknown): string {
  return convertUnexpected(() => {
    const result = canonicalize(value);
    if (typeof result !== "string") {
      throw invalid("REFERENCE_COMPARISON_INVALID", "参考比较值无法规范化");
    }
    return result;
  }, "REFERENCE_COMPARISON_INVALID", "参考比较值无法规范化");
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function parseAudit(
  value: VersionedAuditReport,
  comparisonVersion: FieldComparison["schemaVersion"]
): VersionedAuditReport {
  const schema = comparisonVersion === "2.0.0" ? AuditReportV2Schema : AuditReportV1Schema;
  const parsed = convertUnexpected(
    () => schema.safeParse(value),
    "REVIEW_AUDIT_INVALID",
    "审计报告与比较版本不匹配"
  );
  if (!parsed.success) throw invalid("REVIEW_AUDIT_INVALID", "审计报告与比较版本不匹配");
  return parsed.data as VersionedAuditReport;
}

function parseReference(value: ReferenceEvidenceV1): ReferenceEvidenceV1 {
  const parsed = convertUnexpected(
    () => ReferenceEvidenceV1Schema.safeParse(value),
    "REVIEW_REFERENCE_INVALID",
    "参考集不符合 strict V1 契约"
  );
  if (!parsed.success) throw invalid("REVIEW_REFERENCE_INVALID", "参考集不符合 strict V1 契约");
  return parsed.data;
}

function parseComparison(value: FieldComparison): FieldComparison {
  const schema = value.schemaVersion === "2.0.0" ? FieldComparisonV2Schema : FieldComparisonV1Schema;
  const parsed = convertUnexpected(
    () => schema.safeParse(value),
    "REVIEW_COMPARISON_INVALID",
    "比较结果不符合 strict V1 契约"
  );
  if (!parsed.success) throw invalid("REVIEW_COMPARISON_INVALID", "比较结果不符合 strict V1 契约");
  return parsed.data as FieldComparison;
}

function expectedCandidates(audit: VersionedAuditReport): string[] {
  return audit.manualDecision.status === "selected"
    ? [audit.manualDecision.selectedCandidateId]
    : [...audit.candidateIds].sort(compareUnicodeCodePoints);
}

function applicableCandidates(
  claim: ReferenceClaimV1,
  candidateIds: readonly string[]
): readonly string[] {
  switch (claim.candidateScope.mode) {
    case "all_candidates":
      return candidateIds;
    case "source_record":
      if (!/^time\.(?:original|zone|location|input)\./u.test(claim.fieldPath)) {
        throw invalid("REFERENCE_COMPARISON_INVALID", "source_record scope 与字段轨道不一致");
      }
      return candidateIds;
    case "candidate":
      if (!candidateIds.includes(claim.candidateScope.candidateId)) {
        throw invalid("REFERENCE_COMPARISON_INVALID", "candidate scope 不属于保留候选集");
      }
      return [claim.candidateScope.candidateId];
  }
}

function assertLockedEngineIndependence(sources: readonly ReferenceSourceV1[]): void {
  for (const source of sources) {
    const locked = source.engine?.name === "iztro" && source.engine.version === "2.5.8"
      || source.engine?.name === "lunar-typescript" && source.engine.version === "1.8.6";
    if (locked && source.independence !== "same_engine_excluded") {
      throw invalid(
        "REFERENCE_SOURCE_INDEPENDENCE_INVALID",
        "锁定排盘引擎来源不得标记为独立"
      );
    }
  }
}

function assertClaimsMerged(claims: readonly ReferenceClaimV1[]): void {
  const signatures = new Set<string>();
  for (const claim of claims) {
    const signature = canonical({
      candidateScope: claim.candidateScope,
      track: claim.track,
      fieldPath: claim.fieldPath,
      value: claim.value
    });
    if (signatures.has(signature)) {
      throw invalid("REFERENCE_CLAIM_MERGE_REQUIRED", "相同参考断言必须在比较前合并");
    }
    signatures.add(signature);
  }
}

function rowPathKey(row: Pick<FieldComparisonRowV1, "candidateId" | "track" | "fieldPath">): string {
  return `${row.candidateId}\0${row.track}\0${row.fieldPath}`;
}

/**
 * Task 10 consumes a trusted complete comparator result. These checks prove its
 * reference bindings and independence/status implications, but deliberately do
 * not infer match versus different from nullable values. Task 11 must rerun the
 * official complete comparator profile and require canonical equality.
 */
function validateReferenceComparison(input: {
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
  audit?: VersionedAuditReport;
}): ValidatedArtifacts {
  const reference = parseReference(input.reference);
  const comparison = parseComparison(input.comparison);
  if (
    reference.caseId !== comparison.caseId
    || reference.referenceSetId !== comparison.referenceSetId
    || reference.semanticFingerprint !== comparison.referenceSetFingerprint
  ) {
    throw invalid("REVIEW_ARTIFACT_BINDING_INVALID", "参考集与比较结果绑定不一致");
  }

  const actualCandidateIds = sortedUnique(comparison.rows.map((row) => row.candidateId));
  let candidateIds = actualCandidateIds;
  if (input.audit !== undefined) {
    const audit = parseAudit(input.audit, comparison.schemaVersion);
    if (
      audit.caseId !== comparison.caseId
      || audit.revisionId !== comparison.subjectRevisionId
      || `sha256:${audit.contentFingerprint.value}` !== comparison.auditContentFingerprint
    ) {
      throw invalid("REVIEW_ARTIFACT_BINDING_INVALID", "审计主体与比较结果绑定不一致");
    }
    candidateIds = expectedCandidates(audit);
    if (!equalStrings(actualCandidateIds, candidateIds)) {
      throw invalid("REVIEW_CANDIDATE_SET_INVALID", "比较候选集与审计保留集不一致");
    }
  }

  assertLockedEngineIndependence(reference.sources);
  assertClaimsMerged(reference.claims);
  const claimById = new Map(reference.claims.map((claim) => [claim.claimId, claim]));
  const sourceById = new Map(reference.sources.map((source) => [source.evidenceId, source]));
  const rowsByClaimCandidate = new Map<string, FieldComparisonRowV1[]>();
  const rowsByPath = new Map<string, FieldComparisonRowV1[]>();

  for (const row of comparison.rows) {
    const pathRows = rowsByPath.get(rowPathKey(row)) ?? [];
    pathRows.push(row);
    rowsByPath.set(rowPathKey(row), pathRows);
    if (row.referenceClaimId === null) continue;
    const claim = claimById.get(row.referenceClaimId);
    if (claim === undefined) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较行引用了不存在的参考断言");
    }
    if (!applicableCandidates(claim, candidateIds).includes(row.candidateId)) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较行超出参考断言的候选范围");
    }
    if (
      row.track !== claim.track
      || row.fieldPath !== claim.fieldPath
      || canonical(row.referenceValue) !== canonical(claim.value)
      || !equalStrings(row.sourceEvidenceIds, claim.sourceEvidenceIds)
    ) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较行与参考断言语义不一致");
    }
    const sources = row.sourceEvidenceIds.map((evidenceId) => sourceById.get(evidenceId));
    if (sources.some((source) => source === undefined)) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较行引用了不存在的来源");
    }
    const hasIndependent = sources.some((source) => source?.independence === "independent");
    if (
      (!hasIndependent && (row.machineStatus !== "not_comparable" || row.materiality !== "unresolved"))
      || (hasIndependent && row.machineStatus === "not_comparable")
    ) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较状态与来源独立性不一致");
    }
    const claimCandidateKey = `${claim.claimId}\0${row.candidateId}`;
    const claimRows = rowsByClaimCandidate.get(claimCandidateKey) ?? [];
    claimRows.push(row);
    rowsByClaimCandidate.set(claimCandidateKey, claimRows);
  }

  for (const claim of reference.claims) {
    for (const candidateId of applicableCandidates(claim, candidateIds)) {
      if ((rowsByClaimCandidate.get(`${claim.claimId}\0${candidateId}`) ?? []).length !== 1) {
        throw invalid("REFERENCE_COMPARISON_INVALID", "每个适用参考断言必须恰有一条比较行");
      }
    }
  }

  for (const row of comparison.rows) {
    const pathRows = rowsByPath.get(rowPathKey(row)) ?? [];
    const expectedConflict = new Set(pathRows
      .filter((item) => item.referenceClaimId !== null)
      .map((item) => canonical(item.referenceValue))).size > 1;
    if (row.sourceConflict !== expectedConflict) {
      throw invalid("REFERENCE_COMPARISON_INVALID", "比较行的来源冲突派生值不一致");
    }
    if (row.machineStatus === "not_covered") {
      const applicableClaimExists = reference.claims.some((claim) => (
        claim.track === row.track
        && claim.fieldPath === row.fieldPath
        && applicableCandidates(claim, candidateIds).includes(row.candidateId)
      ));
      if (applicableClaimExists) {
        throw invalid("REFERENCE_COMPARISON_INVALID", "存在适用断言的字段不得标记为未覆盖");
      }
    }
  }

  return { comparison, reference, candidateIds, claimById, sourceById };
}

function requiredRationale(disposition: HumanDecisionV1["disposition"]): boolean {
  return disposition !== "confirmed_match" && disposition !== "acknowledged_not_covered";
}

function dispositionAllowed(row: FieldComparisonRowV1, disposition: HumanDecisionV1["disposition"]): boolean {
  if (disposition === "deferred") return true;
  const allowed = new Set([
    "match/none/confirmed_match",
    "different/none/acknowledged_non_material",
    "different/chart_change/accepted_convention_difference",
    "different/chart_change/confirmed_error",
    "different/unresolved/accepted_convention_difference",
    "not_covered/none/acknowledged_not_covered",
    "not_comparable/unresolved/acknowledged_not_comparable"
  ]);
  return allowed.has(`${row.machineStatus}/${row.materiality}/${disposition}`);
}

function allowedEvidenceRefs(
  row: FieldComparisonRowV1,
  artifacts: ValidatedArtifacts
): Set<string> {
  const allowed = new Set([
    row.rowFingerprint,
    artifacts.comparison.subjectRevisionContentFingerprint,
    artifacts.comparison.auditContentFingerprint,
    artifacts.comparison.chartsArtifactSha256,
    artifacts.comparison.referenceSetFingerprint,
    artifacts.comparison.comparisonFingerprint
  ]);
  if (artifacts.comparison.schemaVersion === "2.0.0") {
    allowed.add(artifacts.comparison.baziDetailFingerprint);
    allowed.add(artifacts.comparison.baziDetailArtifactSha256);
  }
  if (row.referenceClaimId !== null) {
    const claim = artifacts.claimById.get(row.referenceClaimId);
    if (claim !== undefined) allowed.add(claim.claimFingerprint);
  }
  for (const evidenceId of row.sourceEvidenceIds) {
    allowed.add(evidenceId);
    const source = artifacts.sourceById.get(evidenceId);
    if (source !== undefined) {
      allowed.add(source.evidenceFingerprint);
      allowed.add(source.contentSha256);
    }
  }
  return allowed;
}

function validateDecisions(
  rawDecisions: readonly HumanDecisionV1[],
  artifacts: ValidatedArtifacts
): { decisions: HumanDecisionV1[]; status: VerificationStatus } {
  const rowById = new Map(artifacts.comparison.rows.map((row) => [row.rowId, row]));
  const byRowId = new Map<string, HumanDecisionV1>();
  for (const raw of rawDecisions) {
    if (
      raw === null
      || typeof raw !== "object"
      || typeof raw.rowId !== "string"
      || typeof raw.disposition !== "string"
      || (raw.rationale !== null && typeof raw.rationale !== "string")
      || !Array.isArray(raw.evidenceRefs)
      || raw.evidenceRefs.some((reference) => typeof reference !== "string")
    ) {
      throw invalid("DECISION_INVALID", "人工决定不符合 strict V1 契约");
    }
    if (byRowId.has(raw.rowId)) {
      throw invalid("DECISION_ROW_DUPLICATE", "人工决定不得重复引用比较行");
    }
    const row = rowById.get(raw.rowId);
    if (row === undefined) throw invalid("DECISION_ROW_UNKNOWN", "人工决定引用了未知比较行");
    if (!dispositionAllowed(row, raw.disposition)) {
      throw invalid("DECISION_DISPOSITION_INVALID", "人工决定与机器状态或实质性不匹配");
    }
    if (
      (requiredRationale(raw.disposition) && raw.rationale === null)
      || (raw.rationale !== null && raw.rationale.trim().length < 8)
    ) {
      throw invalid("DECISION_RATIONALE_REQUIRED", "该人工决定需要足够长度的理由");
    }
    if (new Set(raw.evidenceRefs).size !== raw.evidenceRefs.length) {
      throw invalid("DECISION_EVIDENCE_REF_DUPLICATE", "人工决定的证据引用不得重复");
    }
    const allowedRefs = allowedEvidenceRefs(row, artifacts);
    if (raw.evidenceRefs.some((reference) => !allowedRefs.has(reference))) {
      throw invalid("DECISION_EVIDENCE_REF_DANGLING", "人工决定包含超出该行证据闭包的引用");
    }
    const parsed = convertUnexpected(
      () => HumanDecisionV1Schema.safeParse({
        ...raw,
        evidenceRefs: [...raw.evidenceRefs].sort(compareUnicodeCodePoints)
      }),
      "DECISION_INVALID",
      "人工决定不符合 strict V1 契约"
    );
    if (!parsed.success) throw invalid("DECISION_INVALID", "人工决定不符合 strict V1 契约");
    byRowId.set(raw.rowId, parsed.data);
  }
  const decisions = artifacts.comparison.rows.flatMap((row) => {
    const item = byRowId.get(row.rowId);
    return item === undefined ? [] : [item];
  });
  const status: VerificationStatus = decisions.some((item) => item.disposition === "confirmed_error")
    ? "blocked"
    : decisions.length !== artifacts.comparison.rows.length
      || decisions.some((item) => item.disposition === "deferred")
      ? "review"
      : "confirmed";
  return { decisions, status };
}

function deriveReferenceCoverageFromArtifacts(
  artifacts: ValidatedArtifacts
): ReferenceCoverageResult {
  const keyset = requiredKeysetPathsForVersion(
    referenceRegistryIdentityForFingerprint(artifacts.reference.semanticFingerprint).version
  );
  const qualified = new Set<string>();
  for (const row of artifacts.comparison.rows) {
    if (row.machineStatus !== "match" || row.sourceConflict) continue;
    const independent = row.sourceEvidenceIds.some((evidenceId) => (
      artifacts.sourceById.get(evidenceId)?.independence === "independent"
    ));
    if (independent) qualified.add(`${row.candidateId}\0${row.track}\0${row.fieldPath}`);
  }

  const missing: ReferenceCoverageResult["missing"] = [];
  let coveredCount = 0;
  for (const candidateId of artifacts.candidateIds) {
    for (const [group, paths] of Object.entries(keyset) as Array<[ReferenceKeysetGroup, string[]]>) {
      const missingPaths = paths.filter((fieldPath) => {
        const track = fieldPath.split(".", 1)[0];
        const covered = qualified.has(`${candidateId}\0${track}\0${fieldPath}`);
        if (covered) coveredCount += 1;
        return !covered;
      });
      if (missingPaths.length > 0) missing.push({ candidateId, group, fieldPaths: missingPaths });
    }
  }
  return {
    coverageStatus: missing.length === 0 ? "complete" : coveredCount === 0 ? "none" : "partial",
    missing
  };
}

export function deriveReferenceCoverage(input: {
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
}): ReferenceCoverageResult {
  const runtimeInput = parseRuntimeInput(ReferenceCoverageInputSchema, input, COVERAGE_INPUT_KEYS);
  return deriveReferenceCoverageFromArtifacts(validateReferenceComparison(runtimeInput));
}

export function buildHumanVerification(
  input: Omit<BuildHumanVerificationInput, "comparison" | "audit"> & {
    comparison: FieldComparisonV1;
    audit: AuditReportV1;
  }
): HumanVerificationV1;
export function buildHumanVerification(
  input: Omit<BuildHumanVerificationInput, "comparison" | "audit"> & {
    comparison: FieldComparisonV2;
    audit: AuditReportV2;
  }
): HumanVerificationV2;
export function buildHumanVerification(input: BuildHumanVerificationInput): HumanVerification;
export function buildHumanVerification(input: BuildHumanVerificationInput): HumanVerification {
  const runtimeInput = parseRuntimeInput(
    BuildHumanVerificationInputSchema,
    input,
    BUILD_INPUT_KEYS,
    BUILD_REQUIRED_INPUT_KEYS
  );
  if (runtimeInput.audit.workflowStatus === "void") {
    throw invalid("REVIEW_SUBJECT_VOID", "已作废的核心修订不得构建人工签认");
  }
  const artifacts = validateReferenceComparison({
    comparison: runtimeInput.comparison,
    reference: runtimeInput.reference,
    audit: runtimeInput.audit
  });
  const validated = validateDecisions(runtimeInput.decisions, artifacts);
  if (
    (validated.status === "review" && runtimeInput.verifiedAt !== null)
    || (validated.status !== "review" && runtimeInput.verifiedAt === null)
  ) {
    throw invalid("VERIFICATION_TIMESTAMP_INVALID", "签认时间的空值性与派生状态不一致");
  }
  const coverageStatus = deriveReferenceCoverageFromArtifacts(artifacts).coverageStatus;
  const detailedComparison = artifacts.comparison.schemaVersion === "2.0.0"
    ? artifacts.comparison
    : undefined;
  const commonDraft = {
    reviewRevisionId: runtimeInput.reviewRevisionId,
    caseId: artifacts.comparison.caseId,
    subjectRevisionId: artifacts.comparison.subjectRevisionId,
    subjectRevisionContentFingerprint: artifacts.comparison.subjectRevisionContentFingerprint,
    auditContentFingerprint: artifacts.comparison.auditContentFingerprint,
    chartsArtifactSha256: artifacts.comparison.chartsArtifactSha256,
    referenceSetId: artifacts.comparison.referenceSetId,
    referenceSetFingerprint: artifacts.comparison.referenceSetFingerprint,
    comparisonId: artifacts.comparison.comparisonId,
    comparisonFingerprint: artifacts.comparison.comparisonFingerprint,
    ...(runtimeInput.previousVerificationFingerprint === undefined
      ? {}
      : { previousVerificationFingerprint: runtimeInput.previousVerificationFingerprint }),
    decisions: validated.decisions,
    verificationStatus: validated.status,
    coverageStatus,
    verifiedBy: "local_operator" as const,
    recordedAt: runtimeInput.recordedAt,
    verifiedAt: runtimeInput.verifiedAt,
    verificationFingerprint: `sha256:${"0".repeat(64)}`
  };
  const draft: HumanVerification = detailedComparison === undefined
    ? { schemaVersion: "1.0.0", ...commonDraft }
    : {
        schemaVersion: "2.0.0",
        ...commonDraft,
        baziDetailFingerprint: detailedComparison.baziDetailFingerprint,
        baziDetailArtifactSha256: detailedComparison.baziDetailArtifactSha256
      };
  draft.verificationFingerprint = convertUnexpected(
    () => computeVerificationFingerprint(draft),
    "VERIFICATION_INVALID",
    "签认指纹无法规范计算"
  );
  const parsed = convertUnexpected(
    () => detailedComparison !== undefined
      ? HumanVerificationV2Schema.safeParse(draft)
      : HumanVerificationV1Schema.safeParse(draft),
    "VERIFICATION_INVALID",
    "签认结果不符合 strict V1 契约"
  );
  if (!parsed.success) throw invalid("VERIFICATION_INVALID", "签认结果不符合 strict V1 契约");
  return parsed.data as HumanVerification;
}

function assertVerificationBinding(
  verification: HumanVerification,
  artifacts: ValidatedArtifacts,
  coverageStatus: ReferenceCoverageResult["coverageStatus"]
): HumanVerification {
  const schema = artifacts.comparison.schemaVersion === "2.0.0"
    ? HumanVerificationV2Schema
    : HumanVerificationV1Schema;
  const parsed = convertUnexpected(
    () => schema.safeParse(verification),
    "VERIFICATION_INVALID",
    "签认记录不符合 strict V1 契约"
  );
  if (!parsed.success) throw invalid("VERIFICATION_INVALID", "签认记录不符合 strict V1 契约");
  const value = parsed.data as HumanVerification;
  const comparison = artifacts.comparison;
  if (
    value.caseId !== comparison.caseId
    || value.subjectRevisionId !== comparison.subjectRevisionId
    || value.subjectRevisionContentFingerprint !== comparison.subjectRevisionContentFingerprint
    || value.auditContentFingerprint !== comparison.auditContentFingerprint
    || value.chartsArtifactSha256 !== comparison.chartsArtifactSha256
    || value.referenceSetId !== comparison.referenceSetId
    || value.referenceSetFingerprint !== comparison.referenceSetFingerprint
    || value.comparisonId !== comparison.comparisonId
    || value.comparisonFingerprint !== comparison.comparisonFingerprint
    || (value.schemaVersion === "2.0.0" && comparison.schemaVersion === "2.0.0" && (
      value.baziDetailFingerprint !== comparison.baziDetailFingerprint
      || value.baziDetailArtifactSha256 !== comparison.baziDetailArtifactSha256
    ))
  ) {
    throw invalid("VERIFICATION_BINDING_INVALID", "签认与比较产物绑定不一致");
  }
  const derived = validateDecisions(value.decisions, artifacts);
  if (
    canonical(derived.decisions) !== canonical(value.decisions)
    || derived.status !== value.verificationStatus
    || coverageStatus !== value.coverageStatus
  ) {
    throw invalid("VERIFICATION_INVALID", "签认的决定顺序或派生状态不一致");
  }
  return value;
}

export type DerivePilotReadinessInput = {
  audit: AuditReportV1;
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
  verification: HumanVerification;
  fingerprintsCurrent: boolean;
} | {
  subject: ReviewSubjectV3;
  audit: AuditReportV2;
  comparison: FieldComparison;
  reference: ReferenceEvidenceV1;
  verification: HumanVerification;
  fingerprintsCurrent: boolean;
};

export function derivePilotReadiness(input: DerivePilotReadinessInput): {
  pilotGate: "ready" | "conditional" | "blocked" | "void";
  coreAllowedModes: VersionedAuditReport["allowedAnalysisModes"];
  finalAllowedModes: VersionedAuditReport["allowedAnalysisModes"];
  coverageStatus: "complete" | "partial" | "none";
} {
  const runtimeInput = parseRuntimeInput(
    PilotReadinessInputSchema,
    input,
    READINESS_INPUT_KEYS,
    READINESS_REQUIRED_INPUT_KEYS
  );
  const comparison = parseComparison(runtimeInput.comparison as FieldComparison);
  const detailed = comparison.schemaVersion === "2.0.0";
  const audit = parseAudit(runtimeInput.audit, comparison.schemaVersion);
  if (detailed) {
    if (!("subject" in runtimeInput) || runtimeInput.subject.subjectContract !== "provided_time_detail_v3") {
      throw invalid("READINESS_SUBJECT_BINDING_INVALID", "V2 readiness 必须绑定当前 V4 Review 主体");
    }
    if (
      comparison.baziDetailFingerprint !== runtimeInput.subject.baziDetailFingerprint
      || comparison.baziDetailArtifactSha256 !== runtimeInput.subject.baziDetailArtifactSha256
      || runtimeInput.subject.auditContentFingerprint !== comparison.auditContentFingerprint
      || runtimeInput.subject.revisionContentFingerprint !== comparison.subjectRevisionContentFingerprint
    ) {
      throw invalid("READINESS_SUBJECT_BINDING_INVALID", "V2 readiness 详盘当前性身份不一致");
    }
  } else if ("subject" in runtimeInput) {
    throw invalid("READINESS_VERSION_MISMATCH", "V1 readiness 不得混入 V4 主体");
  }
  const artifacts = validateReferenceComparison({
    audit,
    comparison,
    reference: runtimeInput.reference
  });
  const coverageStatus = deriveReferenceCoverageFromArtifacts(artifacts).coverageStatus;
  const verification = assertVerificationBinding(
    runtimeInput.verification,
    artifacts,
    coverageStatus
  );
  const coreAllowedModes = [...audit.allowedAnalysisModes];
  if (audit.workflowStatus === "void") {
    return { pilotGate: "void", coreAllowedModes, finalAllowedModes: [], coverageStatus };
  }

  const decisions = verification.decisions;
  const blocked = audit.auditLevel === "D"
    || audit.workflowStatus !== "verified"
    || verification.verificationStatus === "review"
    || verification.verificationStatus === "blocked"
    || decisions.some((item) => item.disposition === "confirmed_error")
    || !runtimeInput.fingerprintsCurrent
    || audit.findings.some((finding) => finding.code === "LOCATION_COORDINATE_UNKNOWN");
  const conditional = audit.auditLevel === "C"
    || coverageStatus !== "complete"
    || decisions.some((item) => item.disposition === "accepted_convention_difference")
    || artifacts.comparison.rows.some((row) => (
      row.machineStatus === "not_covered" || row.machineStatus === "not_comparable"
    ));
  const pilotGate = blocked ? "blocked" : conditional ? "conditional" : "ready";
  const finalAllowedModes = coreAllowedModes.filter((mode) => (
    pilotGate === "ready"
      || pilotGate === "conditional" && mode !== "full_dual"
      || pilotGate === "blocked" && mode === "data_diagnosis"
  ));
  return { pilotGate, coreAllowedModes, finalAllowedModes, coverageStatus };
}

export function deriveReviewSupersededView(input: {
  verification: HumanVerification;
  hasSuccessorVerification: boolean;
  subjectRevisionIsLatestDecision: boolean;
}): { persistedStatus: HumanVerification["verificationStatus"]; superseded: boolean } {
  const runtimeInput = parseRuntimeInput(SupersededViewInputSchema, input, SUPERSEDED_INPUT_KEYS);
  const parsedVerification = convertUnexpected(
    () => runtimeInput.verification.schemaVersion === "2.0.0"
      ? HumanVerificationV2Schema.safeParse(runtimeInput.verification)
      : HumanVerificationV1Schema.safeParse(runtimeInput.verification),
    "VERIFICATION_INVALID",
    "签认记录不符合 strict V1 契约"
  );
  if (!parsedVerification.success) {
    throw invalid("VERIFICATION_INVALID", "签认记录不符合 strict V1 契约");
  }
  return {
    persistedStatus: parsedVerification.data.verificationStatus,
    superseded: runtimeInput.hasSuccessorVerification || !runtimeInput.subjectRevisionIsLatestDecision
  };
}
