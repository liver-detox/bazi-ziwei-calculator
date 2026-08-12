import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import type { ReviewJsonValue } from "./contracts/common.js";
import type { FieldComparison } from "./contracts/field-comparison.js";
import type { EventAppendixV1, EventV1, HandoffPackageV1 } from "./contracts/handoff-package.js";
import type { HandoffPackageV2 } from "./contracts/handoff-package-v2.js";
import type { HumanVerification } from "./contracts/human-verification.js";
import type { ReferenceEvidenceV1 } from "./contracts/reference-evidence.js";

const REFERENCE_EVIDENCE_DOMAIN = "cyber-saga-reference-evidence-v1";
const FIELD_COMPARISON_DOMAIN = "cyber-saga-field-comparison-v1";
const FIELD_COMPARISON_V2_DOMAIN = "cyber-saga-field-comparison-v2";
const HUMAN_VERIFICATION_DOMAIN = "cyber-saga-human-verification-v1";
const HUMAN_VERIFICATION_V2_DOMAIN = "cyber-saga-human-verification-v2";
const HANDOFF_PACKAGE_DOMAIN = "cyber-saga-handoff-package-v1";
const HANDOFF_PACKAGE_V2_DOMAIN = "cyber-saga-handoff-package-v2";
const EVENT_DOMAIN = "cyber-saga-event-v1";
const EVENT_APPENDIX_DOMAIN = "cyber-saga-event-appendix-v1";

export function domainFingerprint(domain: string, value: ReviewJsonValue): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== "string") throw new TypeError("复核内容无法规范序列化");
  return `sha256:${createHash("sha256").update(`${domain}\0${canonical}`, "utf8").digest("hex")}`;
}

function withoutTopLevelFields(
  value: object,
  excludedFields: readonly string[]
): ReviewJsonValue {
  const preimage = { ...value } as Record<string, unknown>;
  for (const field of excludedFields) delete preimage[field];
  return preimage as ReviewJsonValue;
}

export function computeReferenceEvidenceFingerprint(reference: ReferenceEvidenceV1): string {
  return domainFingerprint(
    REFERENCE_EVIDENCE_DOMAIN,
    withoutTopLevelFields(reference, ["referenceSetId", "createdAt", "semanticFingerprint"])
  );
}

export function computeFieldComparisonFingerprint(comparison: FieldComparison): string {
  return domainFingerprint(
    comparison.schemaVersion === "2.0.0" ? FIELD_COMPARISON_V2_DOMAIN : FIELD_COMPARISON_DOMAIN,
    withoutTopLevelFields(comparison, ["comparisonId", "comparisonFingerprint"])
  );
}

export function computeVerificationFingerprint(verification: HumanVerification): string {
  return domainFingerprint(
    verification.schemaVersion === "2.0.0" ? HUMAN_VERIFICATION_V2_DOMAIN : HUMAN_VERIFICATION_DOMAIN,
    withoutTopLevelFields(verification, ["verificationFingerprint"])
  );
}

export function computeHandoffFingerprint(handoff: HandoffPackageV1): string {
  return domainFingerprint(
    HANDOFF_PACKAGE_DOMAIN,
    withoutTopLevelFields(handoff, ["handoffFingerprint"])
  );
}

export function computeHandoffFingerprintV2(handoff: HandoffPackageV2): string {
  return domainFingerprint(
    HANDOFF_PACKAGE_V2_DOMAIN,
    withoutTopLevelFields(handoff, ["handoffFingerprint"])
  );
}

export function computeEventFingerprint(event: EventV1): string {
  return domainFingerprint(
    EVENT_DOMAIN,
    withoutTopLevelFields(event, ["eventFingerprint"])
  );
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function compareAppendixEvents(left: EventV1, right: EventV1): number {
  const fingerprintOrder = compareUnicodeCodePoints(left.eventFingerprint, right.eventFingerprint);
  if (fingerprintOrder !== 0) return fingerprintOrder;

  const leftCanonical = canonicalize(left);
  const rightCanonical = canonicalize(right);
  if (typeof leftCanonical !== "string" || typeof rightCanonical !== "string") {
    throw new TypeError("复核内容无法规范序列化");
  }
  return compareUnicodeCodePoints(leftCanonical, rightCanonical);
}

export function computeEventAppendixFingerprint(appendix: EventAppendixV1): string {
  const preimage = withoutTopLevelFields(appendix, ["appendixFingerprint"]);
  if (preimage === null || Array.isArray(preimage) || typeof preimage !== "object") {
    throw new TypeError("复核内容无法规范序列化");
  }
  return domainFingerprint(EVENT_APPENDIX_DOMAIN, {
    ...preimage,
    events: [...appendix.events].sort(compareAppendixEvents) as ReviewJsonValue[]
  });
}
