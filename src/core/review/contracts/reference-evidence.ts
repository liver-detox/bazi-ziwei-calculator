import { z } from "zod";

import { computeReferenceEvidenceFingerprint } from "../fingerprints.js";
import { assertSemanticId, deriveClaimIdentity, deriveEvidenceIdentity } from "../ids.js";

import {
  CaseIdSchema,
  ClaimIdSchema,
  EvidenceIdSchema,
  ReferenceSetIdSchema,
  ReviewJsonValueSchema,
  ReviewTrackSchema,
  Rfc3339SecondSchema,
  SchemaVersionV1Schema,
  Sha256FingerprintSchema,
  compareUnicodeCodePoints
} from "./common.js";

const SOURCE_LABELS = {
  original_text: "原始文字资料",
  external_screenshot: "外部参考截图",
  manual_panel: "人工核对盘面",
  legacy_generated: "历史同源生成物"
} as const;

const nonEmptyText = z.string().min(1);
const chineseDisplayLabel = nonEmptyText.regex(/\p{Script=Han}/u, "displayLabel 必须使用中文");

export const ReferenceSourceV1Schema = z.object({
  evidenceId: EvidenceIdSchema,
  evidenceFingerprint: Sha256FingerprintSchema,
  kind: z.enum(["original_text", "external_screenshot", "manual_panel", "legacy_generated"]),
  contentSha256: Sha256FingerprintSchema,
  byteLength: z.number().int().nonnegative(),
  displayLabel: z.enum(["原始文字资料", "外部参考截图", "人工核对盘面", "历史同源生成物"]),
  mediaType: z.enum(["text/plain", "image/png", "image/jpeg", "application/json"]),
  engine: z.object({
    name: nonEmptyText,
    version: nonEmptyText
  }).strict().nullable(),
  independence: z.enum(["independent", "unknown", "same_engine_excluded"]),
  privacy: z.enum(["public_derived", "private_local"])
}).strict().superRefine((source, context) => {
  if (source.displayLabel !== SOURCE_LABELS[source.kind]) {
    context.addIssue({
      code: "custom",
      message: "displayLabel 必须与脱敏来源类别一致",
      path: ["displayLabel"]
    });
  }
  const expectedIdentity = deriveEvidenceIdentity(source);
  try {
    assertSemanticId({
      id: source.evidenceId,
      fingerprint: source.evidenceFingerprint,
      prefix: "EVD",
      expectedFingerprint: expectedIdentity.fingerprint
    });
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "evidence 语义身份无效",
      path: ["evidenceId"]
    });
  }
});

const AllCandidatesScopeSchema = z.object({ mode: z.literal("all_candidates") }).strict();
const SourceRecordScopeSchema = z.object({ mode: z.literal("source_record") }).strict();
const CandidateScopeSchema = z.object({
  mode: z.literal("candidate"),
  candidateId: nonEmptyText
}).strict();

export const ReferenceCandidateScopeV1Schema = z.discriminatedUnion("mode", [
  AllCandidatesScopeSchema,
  SourceRecordScopeSchema,
  CandidateScopeSchema
]);

export const ReferenceClaimV1Schema = z.object({
  claimId: ClaimIdSchema,
  claimFingerprint: Sha256FingerprintSchema,
  candidateScope: ReferenceCandidateScopeV1Schema,
  track: ReviewTrackSchema,
  fieldPath: nonEmptyText,
  displayLabel: chineseDisplayLabel,
  value: ReviewJsonValueSchema,
  sourceEvidenceIds: z.array(EvidenceIdSchema).min(1),
  excerptNote: nonEmptyText
}).strict().superRefine((claim, context) => {
  const expectedIdentity = deriveClaimIdentity(claim);
  try {
    assertSemanticId({
      id: claim.claimId,
      fingerprint: claim.claimFingerprint,
      prefix: "CLM",
      expectedFingerprint: expectedIdentity.fingerprint
    });
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "claim 语义身份无效",
      path: ["claimId"]
    });
  }
});

const ConsentAttestationV1Schema = z.object({
  status: z.literal("confirmed_by_operator"),
  scope: z.tuple([
    z.literal("local_development"),
    z.literal("redacted_testing"),
    z.literal("manual_review")
  ]),
  attestedBy: z.literal("local_operator"),
  attestedAt: Rfc3339SecondSchema
}).strict();

export const ReferenceEvidenceV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  caseId: CaseIdSchema,
  referenceSetId: ReferenceSetIdSchema,
  createdAt: Rfc3339SecondSchema,
  consentAttestation: ConsentAttestationV1Schema,
  sources: z.array(ReferenceSourceV1Schema).min(1),
  claims: z.array(ReferenceClaimV1Schema).min(1),
  semanticFingerprint: Sha256FingerprintSchema
}).strict().superRefine((reference, context) => {
  const evidenceIds = new Set<string>();
  const evidenceFingerprints = new Set<string>();
  const evidenceRegistry = new Map<string, string>();
  reference.sources.forEach((source, index) => {
    if (evidenceIds.has(source.evidenceId)) {
      context.addIssue({ code: "custom", message: "evidenceId 必须唯一", path: ["sources", index, "evidenceId"] });
    }
    if (evidenceFingerprints.has(source.evidenceFingerprint)) {
      context.addIssue({ code: "custom", message: "evidenceFingerprint 必须唯一", path: ["sources", index, "evidenceFingerprint"] });
    }
    evidenceIds.add(source.evidenceId);
    evidenceFingerprints.add(source.evidenceFingerprint);
    try {
      assertSemanticId({
        id: source.evidenceId,
        fingerprint: source.evidenceFingerprint,
        prefix: "EVD",
        registry: evidenceRegistry
      });
      evidenceRegistry.set(source.evidenceId, source.evidenceFingerprint);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "evidence 短 ID 碰撞",
        path: ["sources", index, "evidenceId"]
      });
    }
    if (index > 0 && compareUnicodeCodePoints(reference.sources[index - 1].evidenceId, source.evidenceId) >= 0) {
      context.addIssue({ code: "custom", message: "sources 必须按 evidenceId 的 Unicode code point 规范顺序保存", path: ["sources", index] });
    }
  });

  const claimIds = new Set<string>();
  const claimFingerprints = new Set<string>();
  const claimRegistry = new Map<string, string>();
  reference.claims.forEach((claim, index) => {
    if (claimIds.has(claim.claimId)) {
      context.addIssue({ code: "custom", message: "claimId 必须唯一", path: ["claims", index, "claimId"] });
    }
    if (claimFingerprints.has(claim.claimFingerprint)) {
      context.addIssue({ code: "custom", message: "claimFingerprint 必须唯一", path: ["claims", index, "claimFingerprint"] });
    }
    claimIds.add(claim.claimId);
    claimFingerprints.add(claim.claimFingerprint);
    try {
      assertSemanticId({
        id: claim.claimId,
        fingerprint: claim.claimFingerprint,
        prefix: "CLM",
        registry: claimRegistry
      });
      claimRegistry.set(claim.claimId, claim.claimFingerprint);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "claim 短 ID 碰撞",
        path: ["claims", index, "claimId"]
      });
    }
    if (index > 0 && compareUnicodeCodePoints(reference.claims[index - 1].claimId, claim.claimId) >= 0) {
      context.addIssue({ code: "custom", message: "claims 必须按 claimId 的 Unicode code point 规范顺序保存", path: ["claims", index] });
    }

    claim.sourceEvidenceIds.forEach((evidenceId, evidenceIndex) => {
      if (!evidenceIds.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          message: "claim 引用的 evidenceId 不存在",
          path: ["claims", index, "sourceEvidenceIds", evidenceIndex]
        });
      }
      if (
        evidenceIndex > 0
        && compareUnicodeCodePoints(claim.sourceEvidenceIds[evidenceIndex - 1], evidenceId) >= 0
      ) {
        context.addIssue({
          code: "custom",
          message: "sourceEvidenceIds 必须按 Unicode code point 规范顺序保存且唯一",
          path: ["claims", index, "sourceEvidenceIds", evidenceIndex]
        });
      }
    });
  });

  if (reference.semanticFingerprint !== computeReferenceEvidenceFingerprint(reference)) {
    context.addIssue({
      code: "custom",
      message: "semanticFingerprint 必须与参考集公共语义预映像一致",
      path: ["semanticFingerprint"]
    });
  }
});

export type ReferenceSourceV1 = z.infer<typeof ReferenceSourceV1Schema>;
export type ReferenceCandidateScopeV1 = z.infer<typeof ReferenceCandidateScopeV1Schema>;
export type ReferenceClaimV1 = z.infer<typeof ReferenceClaimV1Schema>;
export type ReferenceEvidenceV1 = z.infer<typeof ReferenceEvidenceV1Schema>;
