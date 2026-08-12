import { z } from "zod";

import { computeVerificationFingerprint } from "../fingerprints.js";

import {
  CaseIdSchema,
  ComparisonIdSchema,
  EvidenceIdSchema,
  ReferenceSetIdSchema,
  RevisionIdSchema,
  ReviewRevisionIdSchema,
  Rfc3339SecondSchema,
  RowIdSchema,
  SchemaVersionV1Schema,
  Sha256FingerprintSchema
} from "./common.js";

const DecisionDispositionV1Schema = z.enum([
  "confirmed_match",
  "acknowledged_non_material",
  "accepted_convention_difference",
  "confirmed_error",
  "acknowledged_not_covered",
  "acknowledged_not_comparable",
  "deferred"
]);

const DecisionEvidenceRefV1Schema = z.union([
  EvidenceIdSchema,
  Sha256FingerprintSchema
]);

export const HumanDecisionV1Schema = z.object({
  rowId: RowIdSchema,
  disposition: DecisionDispositionV1Schema,
  rationale: z.string().refine(
    (value) => value.trim().length >= 8,
    "rationale 必须在 trim 后至少包含 8 个非空字符"
  ).nullable(),
  evidenceRefs: z.array(DecisionEvidenceRefV1Schema)
}).strict().superRefine((decision, context) => {
  const rationaleMayBeNull = decision.disposition === "confirmed_match"
    || decision.disposition === "acknowledged_not_covered";
  if (decision.rationale === null && !rationaleMayBeNull) {
    context.addIssue({
      code: "custom",
      message: "该决定必须提供至少 8 个非空字符的理由",
      path: ["rationale"]
    });
  }
});

const HumanVerificationCommonShape = {
  reviewRevisionId: ReviewRevisionIdSchema,
  caseId: CaseIdSchema,
  subjectRevisionId: RevisionIdSchema,
  subjectRevisionContentFingerprint: Sha256FingerprintSchema,
  auditContentFingerprint: Sha256FingerprintSchema,
  chartsArtifactSha256: Sha256FingerprintSchema,
  referenceSetId: ReferenceSetIdSchema,
  referenceSetFingerprint: Sha256FingerprintSchema,
  comparisonId: ComparisonIdSchema,
  comparisonFingerprint: Sha256FingerprintSchema,
  previousVerificationFingerprint: Sha256FingerprintSchema.optional(),
  decisions: z.array(HumanDecisionV1Schema),
  verificationStatus: z.enum(["review", "confirmed", "blocked"]),
  coverageStatus: z.enum(["complete", "partial", "none"]),
  verifiedBy: z.literal("local_operator"),
  recordedAt: Rfc3339SecondSchema,
  verifiedAt: Rfc3339SecondSchema.nullable(),
  verificationFingerprint: Sha256FingerprintSchema
};

type VerificationForRefinement = z.infer<z.ZodObject<typeof HumanVerificationCommonShape>> & {
  schemaVersion: "1.0.0" | "2.0.0";
  baziDetailFingerprint?: string;
  baziDetailArtifactSha256?: string;
};

function refineHumanVerification(
  verification: VerificationForRefinement,
  context: z.RefinementCtx
): void {
  if (
    Object.hasOwn(verification, "previousVerificationFingerprint")
    && verification.previousVerificationFingerprint === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "previousVerificationFingerprint 未使用时必须省略",
      path: ["previousVerificationFingerprint"]
    });
  }
  if (verification.verificationStatus === "review" && verification.verifiedAt !== null) {
    context.addIssue({
      code: "custom",
      message: "review 状态的 verifiedAt 必须为 null",
      path: ["verifiedAt"]
    });
  }
  if (verification.verificationStatus !== "review" && verification.verifiedAt === null) {
    context.addIssue({
      code: "custom",
      message: "confirmed 或 blocked 状态必须记录 verifiedAt",
      path: ["verifiedAt"]
    });
  }

  const rowIds = new Set<string>();
  verification.decisions.forEach((decision, index) => {
    if (rowIds.has(decision.rowId)) {
      context.addIssue({
        code: "custom",
        message: "decision rowId 不得重复",
        path: ["decisions", index, "rowId"]
      });
    }
    rowIds.add(decision.rowId);
  });

  if (verification.verificationFingerprint !== computeVerificationFingerprint(verification as HumanVerification)) {
    context.addIssue({
      code: "custom",
      message: "verificationFingerprint 必须与签认语义预映像一致",
      path: ["verificationFingerprint"]
    });
  }
}

export const HumanVerificationV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  ...HumanVerificationCommonShape
}).strict().superRefine(refineHumanVerification);

export const HumanVerificationV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  ...HumanVerificationCommonShape,
  baziDetailFingerprint: Sha256FingerprintSchema,
  baziDetailArtifactSha256: Sha256FingerprintSchema
}).strict().superRefine(refineHumanVerification);

export type HumanDecisionV1 = z.infer<typeof HumanDecisionV1Schema>;
export type HumanVerificationV1 = z.infer<typeof HumanVerificationV1Schema>;
export type HumanVerificationV2 = z.infer<typeof HumanVerificationV2Schema>;
export type HumanVerification = HumanVerificationV1 | HumanVerificationV2;
