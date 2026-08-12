import { canonicalize } from "json-canonicalize";
import { basename, isAbsolute } from "node:path";

import {
  ReviewJsonValueSchema,
  compareUnicodeCodePoints,
  type ReviewJsonValue
} from "./contracts/common.js";
import {
  ReferenceCandidateScopeV1Schema,
  ReferenceEvidenceV1Schema,
  ReferenceSourceV1Schema,
  type ReferenceCandidateScopeV1,
  type ReferenceEvidenceV1,
  type ReferenceSourceV1
} from "./contracts/reference-evidence.js";
import { ReviewError } from "./errors.js";
import { computeReferenceEvidenceFingerprint } from "./fingerprints.js";
import { deriveClaimIdentity } from "./ids.js";
import { assertPublicSemanticPrivacy } from "./public-semantic-privacy.js";
import type { InspectedReferenceSource } from "./reference-inspector.js";
import {
  bindReferenceRegistryIdentity,
  reviewRegistryIdentityForSubject,
  resolveRegisteredField,
  type ReviewRegistryVersion,
  type ReviewTrack,
  type ReviewField
} from "./registry.js";
import type { ReviewSubject } from "./subject-revision.js";

export interface RawReferenceClaim {
  candidateScope: ReferenceCandidateScopeV1;
  track: ReviewTrack;
  fieldPath: string;
  value: ReviewJsonValue;
  sourceEvidenceIds: readonly string[];
  excerptNote: string;
}

export interface BuildReferenceEvidenceInput {
  subject: ReviewSubject;
  caseId: string;
  referenceSetId: string;
  createdAt: string;
  consentAttestation: {
    readonly status: "confirmed_by_operator";
    readonly scope: readonly ["local_development", "redacted_testing", "manual_review"];
    readonly attestedBy: "local_operator";
    readonly attestedAt: string;
  };
  inspectedSources: readonly InspectedReferenceSource[];
  rawClaims: readonly RawReferenceClaim[];
}

type MutableClaimGroup = {
  candidateScope: ReferenceCandidateScopeV1;
  track: ReviewTrack;
  fieldPath: string;
  displayLabel: string;
  value: ReviewJsonValue;
  sourceEvidenceIds: Set<string>;
  excerptNotes: Set<string>;
};

function invalid(code: string, message: string): ReviewError {
  return new ReviewError(code, message, 422);
}

function sameLockedEngine(engine: ReferenceSourceV1["engine"]): boolean {
  return (
    engine?.name === "iztro" && engine.version === "2.5.8"
  ) || (
    engine?.name === "lunar-typescript" && engine.version === "1.8.6"
  );
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUnicodeCodePoints);
  const sortedExpected = [...expected].sort(compareUnicodeCodePoints);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBuildInputShape(value: unknown): asserts value is BuildReferenceEvidenceInput {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "caseId",
      "subject",
      "referenceSetId",
      "createdAt",
      "consentAttestation",
      "inspectedSources",
      "rawClaims"
    ])
    || typeof value.caseId !== "string"
    || !isRecord(value.subject)
    || typeof value.referenceSetId !== "string"
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.inspectedSources)
    || !Array.isArray(value.rawClaims)
  ) {
    throw invalid("REFERENCE_EVIDENCE_INVALID", "参考集输入无效");
  }

  const consent = value.consentAttestation;
  if (
    !isRecord(consent)
    || !hasExactKeys(consent, ["status", "scope", "attestedBy", "attestedAt"])
    || consent.status !== "confirmed_by_operator"
    || !Array.isArray(consent.scope)
    || consent.scope.length !== 3
    || consent.scope[0] !== "local_development"
    || consent.scope[1] !== "redacted_testing"
    || consent.scope[2] !== "manual_review"
    || consent.attestedBy !== "local_operator"
    || typeof consent.attestedAt !== "string"
  ) {
    throw invalid("REFERENCE_EVIDENCE_INVALID", "参考集授权声明无效");
  }

  for (const inspected of value.inspectedSources) {
    if (
      !isRecord(inspected)
      || !hasExactKeys(inspected, ["publicSource", "privateLocation"])
      || !isRecord(inspected.publicSource)
      || !hasExactKeys(inspected.publicSource, [
        "evidenceId",
        "evidenceFingerprint",
        "kind",
        "contentSha256",
        "byteLength",
        "displayLabel",
        "mediaType",
        "engine",
        "independence",
        "privacy"
      ])
      || !isRecord(inspected.privateLocation)
      || !hasExactKeys(inspected.privateLocation, [
        "schemaVersion",
        "evidenceId",
        "sourcePath",
        "contentSha256",
        "byteLength",
        "mediaType"
      ])
      || typeof inspected.privateLocation.sourcePath !== "string"
    ) {
      throw invalid("REFERENCE_SOURCE_INVALID", "参考来源取证结果无效");
    }
  }

  for (const raw of value.rawClaims) {
    if (
      !isRecord(raw)
      || !hasExactKeys(raw, [
        "candidateScope",
        "track",
        "fieldPath",
        "value",
        "sourceEvidenceIds",
        "excerptNote"
      ])
      || typeof raw.track !== "string"
      || typeof raw.fieldPath !== "string"
      || !Array.isArray(raw.sourceEvidenceIds)
      || !raw.sourceEvidenceIds.every((id) => typeof id === "string")
      || typeof raw.excerptNote !== "string"
    ) {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明格式无效");
    }
  }
}

function privateDenySet(inspectedSources: readonly InspectedReferenceSource[]): string[] {
  const denied = new Set<string>();
  for (const inspected of inspectedSources) {
    const sourcePath = inspected.privateLocation.sourcePath;
    denied.add(sourcePath);
    denied.add(basename(sourcePath));
  }
  return [...denied].filter((value) => value.length > 0);
}

function assertPublicInputsRedacted(
  input: BuildReferenceEvidenceInput,
  inspectedSources: readonly InspectedReferenceSource[],
  rawClaims: readonly RawReferenceClaim[]
): void {
  const deniedStrings = privateDenySet(inspectedSources);
  const assertRedacted = (value: unknown): void => {
    assertPublicSemanticPrivacy(value, deniedStrings);
  };
  assertRedacted({
    caseId: input.caseId,
    referenceSetId: input.referenceSetId,
    createdAt: input.createdAt,
    consentAttestation: input.consentAttestation
  });
  for (const inspected of inspectedSources) {
    assertRedacted(inspected.publicSource);
  }
  for (const claim of rawClaims) {
    assertRedacted(claim.candidateScope);
    assertRedacted(claim.track);
    assertRedacted(claim.fieldPath);
    assertRedacted(claim.value);
    assertRedacted(claim.sourceEvidenceIds);
    assertRedacted(claim.excerptNote);
  }
}

function canonicalClone<T extends ReviewJsonValue>(value: T): T {
  const serialized = canonicalize(value);
  if (typeof serialized !== "string") {
    throw invalid("REFERENCE_CLAIM_INVALID", "参考声明值无法规范化");
  }
  return JSON.parse(serialized) as T;
}

function assertValueType(value: ReviewJsonValue, field: ReviewField): void {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const valid = (() => {
    switch (field.valueType) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "nullable_string":
        return value === null || typeof value === "string";
      case "nullable_number":
        return value === null || (typeof value === "number" && Number.isFinite(value));
      case "string_array":
        return Array.isArray(value) && value.every((item) => typeof item === "string");
      case "number_array":
        return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
      case "object":
        return isObject;
      case "nullable_object":
        return value === null || isObject;
      case "object_array":
        return Array.isArray(value) && value.every(
          (item) => item !== null && typeof item === "object" && !Array.isArray(item)
        );
    }
  })();
  if (!valid) {
    throw invalid("REFERENCE_CLAIM_VALUE_INVALID", "参考声明值与注册字段类型不一致");
  }
}

function normalizeSources(inspectedSources: readonly InspectedReferenceSource[]): {
  sources: ReferenceSourceV1[];
  evidenceIdMap: Map<string, string>;
} {
  if (!Array.isArray(inspectedSources) || inspectedSources.length === 0) {
    throw invalid("REFERENCE_SOURCE_INVALID", "参考来源不能为空");
  }
  const sources: ReferenceSourceV1[] = [];
  const evidenceIdMap = new Map<string, string>();
  const seenInputIds = new Set<string>();
  const seenOutputIds = new Set<string>();
  const seenFingerprints = new Set<string>();

  for (const inspected of inspectedSources) {
    if (
      inspected === null
      || typeof inspected !== "object"
      || Array.isArray(inspected)
      || !hasExactKeys(inspected, ["publicSource", "privateLocation"])
    ) {
      throw invalid("REFERENCE_SOURCE_INVALID", "参考来源取证结果无效");
    }
    const candidate = ReferenceSourceV1Schema.safeParse(inspected.publicSource);
    if (!candidate.success) {
      throw invalid("REFERENCE_SOURCE_INVALID", "参考来源语义身份无效");
    }
    const source = candidate.data;
    if (sameLockedEngine(source.engine) && source.independence !== "same_engine_excluded") {
      throw invalid("REFERENCE_SOURCE_INDEPENDENCE_INVALID", "锁定计算引擎来源必须先完成同源规范化");
    }
    if (seenInputIds.has(source.evidenceId)) {
      throw invalid("REFERENCE_EVIDENCE_DUPLICATE", "参考来源语义 ID 重复");
    }
    seenInputIds.add(source.evidenceId);

    const privateLocation = inspected.privateLocation;
    if (
      privateLocation === null
      || typeof privateLocation !== "object"
      || Array.isArray(privateLocation)
      || !hasExactKeys(privateLocation, [
        "schemaVersion",
        "evidenceId",
        "sourcePath",
        "contentSha256",
        "byteLength",
        "mediaType"
      ])
      || privateLocation.schemaVersion !== "1.0.0"
      || typeof privateLocation.sourcePath !== "string"
      || privateLocation.sourcePath.includes("\0")
      || !isAbsolute(privateLocation.sourcePath)
      || privateLocation.evidenceId !== source.evidenceId
      || privateLocation.contentSha256 !== source.contentSha256
      || privateLocation.byteLength !== source.byteLength
      || privateLocation.mediaType !== source.mediaType
    ) {
      throw invalid("REFERENCE_SOURCE_INVALID", "公开来源与私密位置记录不一致");
    }

    if (seenOutputIds.has(source.evidenceId) || seenFingerprints.has(source.evidenceFingerprint)) {
      throw invalid("REFERENCE_EVIDENCE_DUPLICATE", "参考来源语义身份重复");
    }
    seenOutputIds.add(source.evidenceId);
    seenFingerprints.add(source.evidenceFingerprint);
    evidenceIdMap.set(source.evidenceId, source.evidenceId);
    sources.push(source);
  }

  sources.sort((left, right) => compareUnicodeCodePoints(left.evidenceId, right.evidenceId));
  return { sources, evidenceIdMap };
}

function normalizeScope(value: unknown): ReferenceCandidateScopeV1 {
  const parsed = ReferenceCandidateScopeV1Schema.safeParse(value);
  if (!parsed.success) {
    throw invalid("REFERENCE_CLAIM_INVALID", "参考声明候选范围无效");
  }
  return canonicalClone(parsed.data as ReviewJsonValue) as ReferenceCandidateScopeV1;
}

async function mergeClaims(
  rawClaims: readonly RawReferenceClaim[],
  evidenceIdMap: ReadonlyMap<string, string>,
  registryVersion: ReviewRegistryVersion
): Promise<ReferenceEvidenceV1["claims"]> {
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    throw invalid("REFERENCE_CLAIM_INVALID", "参考声明不能为空");
  }
  const groups = new Map<string, MutableClaimGroup>();
  for (const raw of rawClaims) {
    if (
      raw === null
      || typeof raw !== "object"
      || typeof raw.track !== "string"
      || typeof raw.fieldPath !== "string"
    ) {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明格式无效");
    }
    const resolved = await resolveRegisteredField(registryVersion, raw.track as ReviewTrack, raw.fieldPath);
    const parsedValue = ReviewJsonValueSchema.safeParse(raw.value);
    if (!parsedValue.success) {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明必须是完整 JSON 值");
    }
    assertValueType(parsedValue.data, resolved);
    const value = canonicalClone(parsedValue.data);
    const candidateScope = normalizeScope(raw.candidateScope);
    if (!Array.isArray(raw.sourceEvidenceIds) || raw.sourceEvidenceIds.length === 0) {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明必须引用至少一个来源");
    }
    const sourceEvidenceIds = new Set<string>();
    for (const evidenceId of raw.sourceEvidenceIds) {
      const normalizedId = evidenceIdMap.get(evidenceId);
      if (normalizedId === undefined) {
        throw invalid("REFERENCE_EVIDENCE_DANGLING", "参考声明引用了不存在的来源");
      }
      sourceEvidenceIds.add(normalizedId);
    }
    if (typeof raw.excerptNote !== "string" || raw.excerptNote.length === 0) {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明摘录说明不能为空");
    }

    const keyValue = { candidateScope, track: resolved.track, fieldPath: resolved.fieldPath, value };
    const key = canonicalize(keyValue);
    if (typeof key !== "string") {
      throw invalid("REFERENCE_CLAIM_INVALID", "参考声明无法规范化");
    }
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        ...keyValue,
        displayLabel: resolved.displayLabel,
        sourceEvidenceIds,
        excerptNotes: new Set([raw.excerptNote])
      });
    } else {
      for (const evidenceId of sourceEvidenceIds) existing.sourceEvidenceIds.add(evidenceId);
      existing.excerptNotes.add(raw.excerptNote);
    }
  }

  const claims = [...groups.values()].map((group) => {
    const sourceEvidenceIds = [...group.sourceEvidenceIds].sort(compareUnicodeCodePoints);
    const excerptNote = [...group.excerptNotes].sort(compareUnicodeCodePoints).join("；");
    const identity = deriveClaimIdentity({ ...group, sourceEvidenceIds });
    return {
      claimId: identity.id,
      claimFingerprint: identity.fingerprint,
      candidateScope: group.candidateScope,
      track: group.track,
      fieldPath: group.fieldPath,
      displayLabel: group.displayLabel,
      value: group.value,
      sourceEvidenceIds,
      excerptNote
    };
  });
  claims.sort((left, right) => compareUnicodeCodePoints(left.claimId, right.claimId));
  if (
    new Set(claims.map((claim) => claim.claimId)).size !== claims.length
    || new Set(claims.map((claim) => claim.claimFingerprint)).size !== claims.length
  ) {
    throw invalid("REFERENCE_CLAIM_DUPLICATE", "参考声明语义身份重复");
  }
  return claims;
}

export async function buildReferenceEvidence(
  input: BuildReferenceEvidenceInput
): Promise<ReferenceEvidenceV1> {
  assertBuildInputShape(input);
  if (input.subject.caseId !== input.caseId) {
    throw invalid("REFERENCE_SUBJECT_CASE_MISMATCH", "参考集与核心主体 caseId 不一致");
  }
  const registry = reviewRegistryIdentityForSubject(input.subject);
  assertPublicInputsRedacted(input, input.inspectedSources, input.rawClaims);
  const { sources, evidenceIdMap } = normalizeSources(input.inspectedSources);
  const claims = await mergeClaims(input.rawClaims, evidenceIdMap, registry.version);
  const draft = {
    schemaVersion: "1.0.0" as const,
    caseId: input.caseId,
    referenceSetId: input.referenceSetId,
    createdAt: input.createdAt,
    consentAttestation: {
      status: input.consentAttestation.status,
      scope: [...input.consentAttestation.scope] as [
        "local_development",
        "redacted_testing",
        "manual_review"
      ],
      attestedBy: input.consentAttestation.attestedBy,
      attestedAt: input.consentAttestation.attestedAt
    },
    sources,
    claims,
    semanticFingerprint: `sha256:${"0".repeat(64)}`
  };
  const candidate = {
    ...draft,
    semanticFingerprint: computeReferenceEvidenceFingerprint(draft)
  };
  try {
    const parsed = ReferenceEvidenceV1Schema.parse(candidate);
    bindReferenceRegistryIdentity(parsed.semanticFingerprint, registry);
    return parsed;
  } catch {
    throw invalid("REFERENCE_EVIDENCE_INVALID", "参考集不符合冻结语义契约");
  }
}
