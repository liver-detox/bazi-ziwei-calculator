/**
 * Server-side review domain boundary for V1.1B consumers.
 *
 * Keep this as an explicit whitelist: storage, filesystem locations, registry
 * loaders/resolvers, field extractors, semantic IDs and generic fingerprint
 * helpers remain internal implementation details.
 */

export {
  ReferenceCandidateScopeV1Schema,
  ReferenceClaimV1Schema,
  ReferenceEvidenceV1Schema,
  ReferenceSourceV1Schema
} from "./contracts/reference-evidence.js";
export type {
  ReferenceCandidateScopeV1,
  ReferenceClaimV1,
  ReferenceEvidenceV1,
  ReferenceSourceV1
} from "./contracts/reference-evidence.js";

export {
  FieldComparisonRowV1Schema,
  FieldComparisonV1Schema,
  FieldComparisonV2Schema
} from "./contracts/field-comparison.js";
export type {
  FieldComparison,
  FieldComparisonRowV1,
  FieldComparisonV1,
  FieldComparisonV2
} from "./contracts/field-comparison.js";

export {
  HumanDecisionV1Schema,
  HumanVerificationV1Schema,
  HumanVerificationV2Schema
} from "./contracts/human-verification.js";
export type {
  HumanDecisionV1,
  HumanVerification,
  HumanVerificationV1,
  HumanVerificationV2
} from "./contracts/human-verification.js";

export {
  EventAppendixV1Schema,
  EventV1Schema,
  HandoffPackageV1Schema,
  RedactedBirthRecordV1Schema
} from "./contracts/handoff-package.js";
export {
  HandoffBaziDetailV2Schema,
  HandoffPackageV2Schema
} from "./contracts/handoff-package-v2.js";
export type {
  HandoffBaziDetailV2,
  HandoffPackageV2
} from "./contracts/handoff-package-v2.js";
export type {
  EventAppendixV1,
  EventV1,
  HandoffPackageV1,
  RedactedBirthRecordV1
} from "./contracts/handoff-package.js";

export {
  inspectReferenceSource,
  verifyReferenceSource
} from "./reference-inspector.js";
export type {
  InspectReferenceSourceInput,
  VerifiedReferenceSource
} from "./reference-inspector.js";

export { buildReferenceEvidence } from "./reference-builder.js";
export type {
  BuildReferenceEvidenceInput,
  RawReferenceClaim
} from "./reference-builder.js";

export { parseReviewSubject } from "./subject-revision.js";
export type {
  ReviewSubject,
  ReviewSubjectV1,
  ReviewSubjectV2,
  ReviewSubjectV3
} from "./subject-revision.js";

export { compareRevisionToReference } from "./comparator.js";
export type { CompareRevisionInput } from "./comparator.js";

export {
  assessAlternativeTimeMateriality,
  replayAlternativeMinute
} from "./materiality.js";
export type {
  AlternativeTimeMateriality,
  AlternativeTimeMaterialityInput
} from "./materiality.js";

export {
  buildHumanVerification,
  derivePilotReadiness,
  deriveReferenceCoverage,
  deriveReviewSupersededView
} from "./verification.js";
export type {
  BuildHumanVerificationInput,
  ReferenceCoverageResult
} from "./verification.js";

export {
  COMPARISON_PROFILE_MANIFEST,
  COMPARISON_PROFILE_MANIFEST_V2,
  FIELD_REGISTRY_MANIFEST,
  FIELD_REGISTRY_MANIFEST_V2,
  REFERENCE_KEYSET_MANIFEST,
  REFERENCE_KEYSET_MANIFEST_V2
} from "./registry.js";

export {
  computeEventAppendixFingerprint,
  computeEventFingerprint,
  computeFieldComparisonFingerprint,
  computeHandoffFingerprint,
  computeHandoffFingerprintV2,
  computeReferenceEvidenceFingerprint,
  computeVerificationFingerprint
} from "./fingerprints.js";

export { ReviewError } from "./errors.js";
