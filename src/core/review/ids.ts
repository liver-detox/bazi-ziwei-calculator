import type { ReviewJsonValue } from "./contracts/common.js";
import type { FieldComparisonRowV1 } from "./contracts/field-comparison.js";
import type { ReferenceClaimV1, ReferenceSourceV1 } from "./contracts/reference-evidence.js";
import { ReviewError } from "./errors.js";
import { domainFingerprint } from "./fingerprints.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export type SemanticIdPrefix = "EVD" | "CLM" | "ROW" | "CMP";
export type SequentialIdPrefix = "REF" | "RV";

export interface SemanticIdentity {
  id: string;
  fingerprint: string;
}

export interface AssertSemanticIdInput extends SemanticIdentity {
  prefix: SemanticIdPrefix;
  expectedFingerprint?: string;
  registry?: ReadonlyMap<string, string>;
}

export type EvidenceIdentityInput = Pick<
  ReferenceSourceV1,
  "kind" | "contentSha256" | "byteLength" | "mediaType" | "engine" | "independence" | "privacy"
>;

export type ClaimIdentityInput = Pick<
  ReferenceClaimV1,
  "candidateScope" | "track" | "fieldPath" | "value" | "sourceEvidenceIds"
>;

export type RowIdentityInput = Pick<
  FieldComparisonRowV1,
  "candidateId" | "track" | "fieldPath" | "referenceClaimId"
>;

function semanticIdentity(prefix: SemanticIdPrefix, fingerprint: string): SemanticIdentity {
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw new ReviewError("SEMANTIC_ID_MISMATCH", "语义指纹格式无效", 422);
  }
  return {
    id: `${prefix}-${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint
  };
}

export function deriveEvidenceIdentity(source: EvidenceIdentityInput): SemanticIdentity {
  const semanticBody = {
    kind: source.kind,
    contentSha256: source.contentSha256,
    byteLength: source.byteLength,
    mediaType: source.mediaType,
    engine: source.engine,
    independence: source.independence,
    privacy: source.privacy
  } satisfies ReviewJsonValue;
  return semanticIdentity("EVD", domainFingerprint("cyber-saga-evidence-id-v1", semanticBody));
}

export function deriveClaimIdentity(claim: ClaimIdentityInput): SemanticIdentity {
  const normalizedSourceEvidenceIds = [...new Set(claim.sourceEvidenceIds)].sort();
  const semanticBody = {
    candidateScope: claim.candidateScope,
    track: claim.track,
    fieldPath: claim.fieldPath,
    value: claim.value,
    sourceEvidenceIds: normalizedSourceEvidenceIds
  } as ReviewJsonValue;
  return semanticIdentity("CLM", domainFingerprint("cyber-saga-claim-id-v1", semanticBody));
}

export function deriveRowIdentity(row: RowIdentityInput): SemanticIdentity {
  const semanticBody = {
    candidateId: row.candidateId,
    track: row.track,
    fieldPath: row.fieldPath,
    referenceClaimId: row.referenceClaimId ?? "NO_CLAIM"
  } satisfies ReviewJsonValue;
  return semanticIdentity("ROW", domainFingerprint("cyber-saga-row-id-v1", semanticBody));
}

export function deriveComparisonIdentity(comparisonFingerprint: string): SemanticIdentity {
  return semanticIdentity("CMP", comparisonFingerprint);
}

export function assertSemanticId(input: AssertSemanticIdInput): void {
  if (
    input.prefix !== "EVD"
    && input.prefix !== "CLM"
    && input.prefix !== "ROW"
    && input.prefix !== "CMP"
  ) {
    throw new ReviewError("SEMANTIC_ID_MISMATCH", "语义 ID 前缀无效", 422);
  }
  const expectedId = SHA256_PATTERN.test(input.fingerprint)
    ? `${input.prefix}-${input.fingerprint.slice("sha256:".length, "sha256:".length + 16)}`
    : null;
  if (expectedId === null || input.id !== expectedId) {
    throw new ReviewError(
      "SEMANTIC_ID_MISMATCH",
      `语义 ID 必须与 ${input.prefix} 前缀和完整指纹的前 16 位摘要一致`,
      422
    );
  }
  if (input.expectedFingerprint !== undefined && input.fingerprint !== input.expectedFingerprint) {
    throw new ReviewError(
      "SEMANTIC_FINGERPRINT_MISMATCH",
      "对象声明的完整指纹与重新派生值不一致",
      422
    );
  }
  const registeredFingerprint = input.registry?.get(input.id);
  if (registeredFingerprint !== undefined && registeredFingerprint !== input.fingerprint) {
    throw new ReviewError(
      "SEMANTIC_ID_COLLISION",
      "同一短 ID 对应了不同的完整指纹",
      409
    );
  }
}

export function nextSequentialId(
  prefix: SequentialIdPrefix,
  committedIds: readonly string[]
): string {
  if (prefix !== "REF" && prefix !== "RV") {
    throw new ReviewError("SEQUENTIAL_ID_INVALID", "顺序 ID 前缀无效", 422);
  }
  const pattern = prefix === "REF" ? /^REF([0-9]{3})$/u : /^RV([0-9]{3})$/u;
  const seen = new Set<string>();
  let maximum = 0;
  for (const id of committedIds) {
    const match = pattern.exec(id);
    const sequence = match === null ? 0 : Number(match[1]);
    if (match === null || sequence < 1) {
      throw new ReviewError("SEQUENTIAL_ID_INVALID", `已提交的 ${prefix} 顺序 ID 格式无效`, 422);
    }
    if (seen.has(id)) {
      throw new ReviewError("SEQUENTIAL_ID_DUPLICATE", `已提交的 ${prefix} 顺序 ID 重复`, 409);
    }
    seen.add(id);
    maximum = Math.max(maximum, sequence);
  }
  if (maximum >= 999) {
    throw new ReviewError("SEQUENTIAL_ID_EXHAUSTED", `${prefix} 顺序 ID 已超过 999`, 409);
  }
  return `${prefix}${String(maximum + 1).padStart(3, "0")}`;
}
