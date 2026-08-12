import { canonicalize } from "json-canonicalize";

import type { ReviewJsonValue } from "./contracts/common.js";
import { compareUnicodeCodePoints } from "./contracts/common.js";
import {
  FieldComparisonV1Schema,
  FieldComparisonV2Schema,
  type FieldComparison,
  type FieldComparisonRowV1,
  type FieldComparisonV1,
  type FieldComparisonV2
} from "./contracts/field-comparison.js";
import {
  ReferenceEvidenceV1Schema,
  type ReferenceClaimV1,
  type ReferenceEvidenceV1,
  type ReferenceSourceV1
} from "./contracts/reference-evidence.js";
import { ReviewError } from "./errors.js";
import { extractRegisteredFields, assertRegisteredValue } from "./field-extractors.js";
import { computeFieldComparisonFingerprint } from "./fingerprints.js";
import { deriveComparisonIdentity, deriveRowIdentity } from "./ids.js";
import * as reviewMateriality from "./materiality.js";
import {
  expandComparisonProfile,
  referenceRegistryIdentityForFingerprint,
  reviewRegistryIdentityForSubject,
  resolveRegisteredField,
  type ResolvedRegisteredField
} from "./registry.js";
import type {
  ReviewSubject,
  ReviewSubjectV1,
  ReviewSubjectV2,
  ReviewSubjectV3
} from "./subject-revision.js";

export interface CompareRevisionInput {
  subject: ReviewSubject;
  reference: ReferenceEvidenceV1;
  materialityForDifference?: (input: {
    subject: ReviewSubject;
    candidateId: string;
    fieldPath: string;
    computedValue: ReviewJsonValue;
    referenceValue: ReviewJsonValue;
  }) => "none" | "chart_change" | "unresolved";
}

type ResolvedClaim = {
  claim: ReferenceClaimV1;
  field: ResolvedRegisteredField;
};

function invalid(code: string, message: string, cause?: unknown): ReviewError {
  return new ReviewError(code, message, 422, cause === undefined ? undefined : { cause });
}

function canonical(value: ReviewJsonValue): string {
  const result = canonicalize(value);
  if (typeof result !== "string") throw invalid("REVIEW_VALUE_CANONICALIZATION_FAILED", "复核值无法规范序列化");
  return result;
}

function assertRetainedSubject(subject: ReviewSubject): string[] {
  const retained = [...subject.retainedCandidateIds];
  if (retained.length === 0 || new Set(retained).size !== retained.length) {
    throw invalid("REVIEW_SUBJECT_RETAINED_INVALID", "retainedCandidateIds 必须非空且唯一");
  }
  const sorted = [...retained].sort(compareUnicodeCodePoints);
  if (retained.some((candidateId, index) => candidateId !== sorted[index])) {
    throw invalid("REVIEW_SUBJECT_RETAINED_INVALID", "retainedCandidateIds 必须按 Unicode code point 排序");
  }
  const chartIds = subject.charts.candidates.map((candidate) => candidate.candidateId);
  const expected = subject.audit.manualDecision.status === "selected"
    ? [subject.audit.manualDecision.selectedCandidateId]
    : [...chartIds].sort(compareUnicodeCodePoints);
  if (
    expected.length !== retained.length
    || expected.some((candidateId, index) => candidateId !== retained[index])
    || retained.some((candidateId) => !chartIds.includes(candidateId))
  ) {
    throw invalid("REVIEW_SUBJECT_RETAINED_INVALID", "保留候选与核心 manualDecision 不一致");
  }
  return retained;
}

function applicableCandidateIds(
  claim: ReferenceClaimV1,
  retainedCandidateIds: readonly string[]
): readonly string[] {
  switch (claim.candidateScope.mode) {
    case "all_candidates":
      return retainedCandidateIds;
    case "source_record":
      if (!/^time\.(?:original|zone|location|input)\./u.test(claim.fieldPath)) {
        throw invalid(
          "REVIEW_SOURCE_RECORD_SCOPE_INVALID",
          `source_record 仅允许 source-level time path: ${claim.fieldPath}`
        );
      }
      return retainedCandidateIds;
    case "candidate":
      if (!retainedCandidateIds.includes(claim.candidateScope.candidateId)) {
        throw invalid(
          "REVIEW_REFERENCE_CANDIDATE_INVALID",
          `candidate scope 必须精确引用被保留候选: ${claim.candidateScope.candidateId}`
        );
      }
      return [claim.candidateScope.candidateId];
  }
}

async function resolveClaims(
  reference: ReferenceEvidenceV1,
  subject: ReviewSubject,
  retainedCandidateIds: readonly string[]
): Promise<Map<string, ResolvedClaim[]>> {
  const registry = reviewRegistryIdentityForSubject(subject);
  const byCandidate = new Map(retainedCandidateIds.map((candidateId) => [candidateId, [] as ResolvedClaim[]]));
  for (const claim of reference.claims) {
    let field: ResolvedRegisteredField;
    try {
      field = await resolveRegisteredField(registry.version, claim.track, claim.fieldPath);
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw invalid("REVIEW_REFERENCE_FIELD_INVALID", `参考字段无法解析: ${claim.fieldPath}`, error);
    }
    assertRegisteredValue(field, claim.value);
    if (field.expansion === "target_year") {
      const targetYear = Number(field.parameters.targetYear);
      if (!subject.charts.targetYears.includes(targetYear)) {
        throw invalid(
          "REVIEW_REFERENCE_TARGET_YEAR_INVALID",
          `参考 targetYear 不在核心主体盘集中: ${targetYear}`
        );
      }
    }
    for (const candidateId of applicableCandidateIds(claim, retainedCandidateIds)) {
      const claims = byCandidate.get(candidateId);
      if (claims === undefined) {
        throw invalid("REVIEW_REFERENCE_CANDIDATE_INVALID", `参考候选不属于核心主体: ${candidateId}`);
      }
      claims.push({ claim, field });
    }
  }
  return byCandidate;
}

function sourcesForClaim(
  claim: ReferenceClaimV1,
  sourceById: ReadonlyMap<string, ReferenceSourceV1>
): ReferenceSourceV1[] {
  return claim.sourceEvidenceIds.map((evidenceId) => {
    const source = sourceById.get(evidenceId);
    if (source === undefined) {
      throw invalid("REVIEW_REFERENCE_SOURCE_INVALID", `claim 引用不存在的 source: ${evidenceId}`);
    }
    return source;
  });
}

function sourceConflict(claims: readonly ResolvedClaim[]): boolean {
  return new Set(claims.map(({ claim }) => canonical(claim.value))).size > 1;
}

function makeRow(input: Omit<FieldComparisonRowV1, "rowId" | "rowFingerprint">): FieldComparisonRowV1 {
  const identity = deriveRowIdentity(input);
  return { rowId: identity.id, rowFingerprint: identity.fingerprint, ...input };
}

function compareRows(left: FieldComparisonRowV1, right: FieldComparisonRowV1): number {
  return compareUnicodeCodePoints(left.candidateId, right.candidateId)
    || compareUnicodeCodePoints(left.track, right.track)
    || compareUnicodeCodePoints(left.fieldPath, right.fieldPath)
    || compareUnicodeCodePoints(left.referenceClaimId ?? "NO_CLAIM", right.referenceClaimId ?? "NO_CLAIM")
    || compareUnicodeCodePoints(left.rowId, right.rowId);
}

function differenceMateriality(
  input: CompareRevisionInput,
  candidateId: string,
  field: ResolvedRegisteredField,
  computedValue: ReviewJsonValue,
  referenceValue: ReviewJsonValue,
  defaultMaterialityCache: Map<string, FieldComparisonRowV1["materiality"]>
): FieldComparisonRowV1["materiality"] {
  if (input.materialityForDifference !== undefined) {
    const fromProvider = input.materialityForDifference({
      subject: input.subject,
      candidateId,
      fieldPath: field.fieldPath,
      computedValue,
      referenceValue
    });
    if (fromProvider === undefined) return field.track === "time" ? "unresolved" : "chart_change";
    if (fromProvider !== "none" && fromProvider !== "chart_change" && fromProvider !== "unresolved") {
      throw invalid("REVIEW_MATERIALITY_INVALID", "materiality provider 返回了无效值");
    }
    return fromProvider;
  }
  if (
    (field.fieldPath === "time.original.localTime" || field.fieldPath === "time.input.localTime")
    && typeof referenceValue === "string"
    && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(referenceValue)
  ) {
    const cached = defaultMaterialityCache.get(referenceValue);
    if (cached !== undefined) return cached;
    const assessed = reviewMateriality.assessAlternativeTimeMateriality({
      subject: input.subject,
      alternativeLocalTime: referenceValue
    });
    defaultMaterialityCache.set(referenceValue, assessed);
    return assessed;
  }
  return field.track === "time" ? "unresolved" : "chart_change";
}

function assertReferenceOnlyAllowed(field: ResolvedRegisteredField): void {
  if (field.expansion !== "palace_star" && field.expansion !== "da_yun") {
    throw invalid(
      "REVIEW_REFERENCE_ENTITY_NOT_APPLICABLE",
      `参考字段在主体 profile expansion 中不适用: ${field.fieldPath}`
    );
  }
}

async function rowsForCandidate(
  input: CompareRevisionInput,
  candidateId: string,
  claims: readonly ResolvedClaim[],
  sourceById: ReadonlyMap<string, ReferenceSourceV1>,
  defaultMaterialityCache: Map<string, FieldComparisonRowV1["materiality"]>
): Promise<FieldComparisonRowV1[]> {
  const computedFields = await extractRegisteredFields(input.subject, candidateId);
  const registry = reviewRegistryIdentityForSubject(input.subject);
  const expanded = await expandComparisonProfile(registry.version, input.subject.charts, candidateId);
  const fieldByPath = new Map(expanded.map((field) => [field.fieldPath, field]));
  for (const resolved of claims) {
    const existing = fieldByPath.get(resolved.field.fieldPath);
    if (existing === undefined) {
      assertReferenceOnlyAllowed(resolved.field);
      fieldByPath.set(resolved.field.fieldPath, resolved.field);
    } else if (existing.track !== resolved.claim.track) {
      throw invalid("REVIEW_REFERENCE_TRACK_INVALID", `参考 track 与 profile 不一致: ${resolved.claim.fieldPath}`);
    }
  }
  const claimsByPath = new Map<string, ResolvedClaim[]>();
  for (const resolved of claims) {
    const list = claimsByPath.get(resolved.claim.fieldPath) ?? [];
    list.push(resolved);
    claimsByPath.set(resolved.claim.fieldPath, list);
  }

  const rows: FieldComparisonRowV1[] = [];
  const fieldPaths = [...fieldByPath.keys()].sort(compareUnicodeCodePoints);
  for (const fieldPath of fieldPaths) {
    const field = fieldByPath.get(fieldPath)!;
    const pathClaims = claimsByPath.get(fieldPath) ?? [];
    const hasComputedValue = computedFields.has(fieldPath);
    const computedValue = computedFields.get(fieldPath) ?? null;
    if (pathClaims.length === 0) {
      rows.push(makeRow({
        candidateId,
        track: field.track,
        fieldPath,
        displayLabel: field.displayLabel,
        referenceClaimId: null,
        computedValue,
        referenceValue: null,
        machineStatus: "not_covered",
        materiality: "none",
        sourceEvidenceIds: [],
        sourceConflict: false
      }));
      continue;
    }

    const conflict = sourceConflict(pathClaims);
    for (const { claim } of pathClaims) {
      const sources = sourcesForClaim(claim, sourceById);
      const comparable = sources.some((source) => source.independence === "independent");
      const equal = hasComputedValue && canonical(computedValue) === canonical(claim.value);
      const machineStatus = !comparable ? "not_comparable" : equal ? "match" : "different";
      const materiality = machineStatus === "match"
        ? "none"
        : machineStatus === "not_comparable"
          ? "unresolved"
          : differenceMateriality(
              input,
              candidateId,
              field,
              computedValue,
              claim.value,
              defaultMaterialityCache
            );
      rows.push(makeRow({
        candidateId,
        track: field.track,
        fieldPath,
        displayLabel: field.displayLabel,
        referenceClaimId: claim.claimId,
        computedValue,
        referenceValue: claim.value,
        machineStatus,
        materiality,
        sourceEvidenceIds: [...claim.sourceEvidenceIds],
        sourceConflict: conflict
      }));
    }
  }
  return rows;
}

export function compareRevisionToReference(
  input: CompareRevisionInput & { subject: ReviewSubjectV3 }
): Promise<FieldComparisonV2>;
export function compareRevisionToReference(
  input: CompareRevisionInput & { subject: ReviewSubjectV1 | ReviewSubjectV2 }
): Promise<FieldComparisonV1>;
export function compareRevisionToReference(input: CompareRevisionInput): Promise<FieldComparison>;
export async function compareRevisionToReference(
  input: CompareRevisionInput
): Promise<FieldComparison> {
  const retainedCandidateIds = assertRetainedSubject(input.subject);
  if (input.subject.caseId !== input.reference.caseId) {
    throw invalid("REVIEW_REFERENCE_CASE_MISMATCH", "参考集与核心修订 caseId 不一致");
  }
  const parsedReference = ReferenceEvidenceV1Schema.safeParse(input.reference);
  if (!parsedReference.success) {
    throw invalid("REVIEW_REFERENCE_INVALID", "参考集不符合 strict V1 契约", parsedReference.error);
  }
  const reference = parsedReference.data;
  const subjectRegistry = reviewRegistryIdentityForSubject(input.subject);
  const referenceRegistry = referenceRegistryIdentityForFingerprint(reference.semanticFingerprint);
  if (referenceRegistry.version !== subjectRegistry.version) {
    throw invalid("REVIEW_REFERENCE_REGISTRY_MISMATCH", "参考集与核心主体使用了不同版本的比较规则");
  }
  const sourceById = new Map(reference.sources.map((source) => [source.evidenceId, source]));
  const claimsByCandidate = await resolveClaims(reference, input.subject, retainedCandidateIds);
  const defaultMaterialityCache = new Map<string, FieldComparisonRowV1["materiality"]>();
  const nestedRows = await Promise.all(retainedCandidateIds.map((candidateId) => rowsForCandidate(
    input,
    candidateId,
    claimsByCandidate.get(candidateId) ?? [],
    sourceById,
    defaultMaterialityCache
  )));
  const rows = nestedRows.flat().sort(compareRows);

  // Task 2 deferred invariant: no row may escape the parsed core subject.
  if (rows.some((row) => !retainedCandidateIds.includes(row.candidateId))) {
    throw invalid("REVIEW_ROW_CANDIDATE_INVALID", "比较行 candidateId 必须来自 subject.retainedCandidateIds");
  }
  const rowIds = rows.map((row) => row.rowId);
  if (new Set(rowIds).size !== rowIds.length) {
    throw invalid("REVIEW_ROW_DUPLICATE", "比较行身份重复");
  }
  const detailedSubject = input.subject.subjectContract === "provided_time_detail_v3"
    ? input.subject
    : undefined;
  const commonDraft = {
    comparisonId: `CMP-${"0".repeat(16)}`,
    caseId: input.subject.caseId,
    subjectRevisionId: input.subject.revisionId,
    subjectRevisionContentFingerprint: input.subject.revisionContentFingerprint,
    auditContentFingerprint: input.subject.auditContentFingerprint,
    chartsArtifactSha256: input.subject.chartsArtifactSha256,
    referenceSetId: reference.referenceSetId,
    referenceSetFingerprint: reference.semanticFingerprint,
    rows,
    comparisonFingerprint: `sha256:${"0".repeat(64)}`
  };
  const draft: FieldComparison = detailedSubject === undefined
    ? { schemaVersion: "1.0.0", ...commonDraft }
    : {
        schemaVersion: "2.0.0",
        ...commonDraft,
        baziDetailFingerprint: detailedSubject.baziDetailFingerprint,
        baziDetailArtifactSha256: detailedSubject.baziDetailArtifactSha256
      };
  const comparisonFingerprint = computeFieldComparisonFingerprint(draft);
  const comparisonIdentity = deriveComparisonIdentity(comparisonFingerprint);
  const candidate = {
    ...draft,
    comparisonId: comparisonIdentity.id,
    comparisonFingerprint
  };
  const parsedComparison = detailedSubject !== undefined
    ? FieldComparisonV2Schema.safeParse(candidate)
    : FieldComparisonV1Schema.safeParse(candidate);
  if (!parsedComparison.success) {
    throw invalid(
      "REVIEW_COMPARISON_INVALID",
      detailedSubject !== undefined ? "比较结果不符合 strict V2 契约" : "比较结果不符合 strict V1 契约",
      parsedComparison.error
    );
  }
  return parsedComparison.data as FieldComparison;
}
