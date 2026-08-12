import { ReviewError } from "./errors.js";
import type { ReferenceEvidenceV1 } from "./contracts/reference-evidence.js";

const FILE_URI_PATTERN = /(?:^|[^\p{L}\p{N}_+.-])file:(?=\s*\S)/iu;
const WINDOWS_DRIVE_ROOT_PATTERN = /(?:^|[^\p{L}\p{N}_])[A-Za-z]:[\\/][^\s<>"'`|?*\u0000-\u001f]*/u;
const WINDOWS_ROOTED_PATTERN = /(?:^|[^\p{L}\p{N}_\\/.])\\(?!\\)(?=[^\s\\/])[^\s<>"'`|?*\u0000-\u001f]*/u;
const WINDOWS_UNC_PATTERN = /(?:^|[^\p{L}\p{N}_])\\{2,}[^\\/\s]+/u;
const FORWARD_UNC_PATTERN = /(?:^|[^\p{L}\p{N}_:/])\/{2,}[^/\s]+/u;
const POSIX_ABSOLUTE_PATTERN = /(?:^|[^\p{L}\p{N}_/.])\/(?!\/)(?=[^\s/])[^\s<>"'`|?*\u0000-\u001f]*/u;
const PRIVATE_KEY_NAMES = new Set([
  "path",
  "sourcepath",
  "realpath",
  "filepath",
  "absolutepath",
  "basename",
  "modifiedat",
  "mtime",
  "mtimems"
]);

function privacyViolation(): ReviewError {
  return new ReviewError(
    "REFERENCE_PRIVACY_VIOLATION",
    "公开参考语义包含私密路径信息",
    422
  );
}

function containsAbsolutePath(value: string): boolean {
  return FILE_URI_PATTERN.test(value)
    || WINDOWS_DRIVE_ROOT_PATTERN.test(value)
    || WINDOWS_ROOTED_PATTERN.test(value)
    || WINDOWS_UNC_PATTERN.test(value)
    || FORWARD_UNC_PATTERN.test(value)
    || POSIX_ABSOLUTE_PATTERN.test(value);
}

function isPrivateKeyName(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
  return PRIVATE_KEY_NAMES.has(normalized)
    || normalized.endsWith("path")
    || normalized.endsWith("basename")
    || normalized.endsWith("modifiedat")
    || normalized.includes("mtime");
}

export function assertPublicSemanticPrivacy(
  value: unknown,
  deniedStrings: readonly string[] = [],
  seen = new WeakSet<object>()
): void {
  if (typeof value === "string") {
    if (
      containsAbsolutePath(value)
      || deniedStrings.some((denied) => denied.length > 0 && value.includes(denied))
    ) {
      throw privacyViolation();
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw privacyViolation();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertPublicSemanticPrivacy(item, deniedStrings, seen);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateKeyName(key)) throw privacyViolation();
      assertPublicSemanticPrivacy(key, deniedStrings, seen);
      assertPublicSemanticPrivacy(item, deniedStrings, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function assertReferenceEvidencePublicPrivacy(
  evidence: ReferenceEvidenceV1,
  deniedStrings: readonly string[] = []
): void {
  assertPublicSemanticPrivacy([
    evidence.schemaVersion,
    evidence.caseId,
    evidence.referenceSetId,
    evidence.createdAt,
    evidence.consentAttestation,
    evidence.sources,
    evidence.semanticFingerprint
  ], deniedStrings);
  for (const claim of evidence.claims) {
    assertPublicSemanticPrivacy([
      claim.claimId,
      claim.claimFingerprint,
      claim.candidateScope,
      claim.track,
      claim.fieldPath,
      claim.displayLabel,
      claim.value,
      claim.sourceEvidenceIds,
      claim.excerptNote
    ], deniedStrings);
  }
}
