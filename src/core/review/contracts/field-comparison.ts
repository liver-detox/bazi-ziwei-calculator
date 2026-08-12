import { z } from "zod";

import { computeFieldComparisonFingerprint } from "../fingerprints.js";
import { assertSemanticId, deriveComparisonIdentity, deriveRowIdentity } from "../ids.js";

import {
  CaseIdSchema,
  ClaimIdSchema,
  ComparisonIdSchema,
  EvidenceIdSchema,
  ReferenceSetIdSchema,
  RevisionIdSchema,
  ReviewJsonValueSchema,
  ReviewTrackSchema,
  RowIdSchema,
  SchemaVersionV1Schema,
  Sha256FingerprintSchema,
  compareUnicodeCodePoints
} from "./common.js";

const nonEmptyText = z.string().min(1);

export const FieldComparisonRowV1Schema = z.object({
  rowId: RowIdSchema,
  rowFingerprint: Sha256FingerprintSchema,
  candidateId: nonEmptyText,
  track: ReviewTrackSchema,
  fieldPath: nonEmptyText,
  displayLabel: nonEmptyText,
  referenceClaimId: ClaimIdSchema.nullable(),
  computedValue: ReviewJsonValueSchema,
  referenceValue: ReviewJsonValueSchema.nullable(),
  machineStatus: z.enum(["match", "different", "not_covered", "not_comparable"]),
  materiality: z.enum(["none", "chart_change", "unresolved"]),
  sourceEvidenceIds: z.array(EvidenceIdSchema),
  sourceConflict: z.boolean()
}).strict().superRefine((row, context) => {
  const expectedIdentity = deriveRowIdentity(row);
  try {
    assertSemanticId({
      id: row.rowId,
      fingerprint: row.rowFingerprint,
      prefix: "ROW",
      expectedFingerprint: expectedIdentity.fingerprint
    });
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "row 语义身份无效",
      path: ["rowId"]
    });
  }

  if (row.machineStatus === "match" && row.materiality !== "none") {
    context.addIssue({ code: "custom", message: "match 行的 materiality 必须为 none", path: ["materiality"] });
  }
  if (row.machineStatus === "not_comparable" && row.materiality !== "unresolved") {
    context.addIssue({ code: "custom", message: "not_comparable 行的 materiality 必须为 unresolved", path: ["materiality"] });
  }
  if (row.machineStatus === "not_covered") {
    if (row.referenceClaimId !== null) {
      context.addIssue({ code: "custom", message: "not_covered 行不能引用 claim", path: ["referenceClaimId"] });
    }
    if (row.referenceValue !== null) {
      context.addIssue({ code: "custom", message: "not_covered 行的 referenceValue 必须为 null", path: ["referenceValue"] });
    }
    if (row.sourceEvidenceIds.length !== 0) {
      context.addIssue({ code: "custom", message: "not_covered 行的来源必须为空", path: ["sourceEvidenceIds"] });
    }
    if (row.materiality !== "none") {
      context.addIssue({ code: "custom", message: "not_covered 行的 materiality 必须为 none", path: ["materiality"] });
    }
  } else {
    if (row.referenceClaimId === null) {
      context.addIssue({ code: "custom", message: "已覆盖行必须引用 claim", path: ["referenceClaimId"] });
    }
    if (row.sourceEvidenceIds.length === 0) {
      context.addIssue({ code: "custom", message: "已覆盖行必须引用至少一个来源", path: ["sourceEvidenceIds"] });
    }
  }

  row.sourceEvidenceIds.forEach((evidenceId, index) => {
    if (
      index > 0
      && compareUnicodeCodePoints(row.sourceEvidenceIds[index - 1], evidenceId) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceEvidenceIds 必须按 Unicode code point 规范顺序保存且唯一",
        path: ["sourceEvidenceIds", index]
      });
    }
  });
});

type ComparisonRow = z.infer<typeof FieldComparisonRowV1Schema>;

function compareRows(left: ComparisonRow, right: ComparisonRow): number {
  return compareUnicodeCodePoints(left.candidateId, right.candidateId)
    || compareUnicodeCodePoints(left.track, right.track)
    || compareUnicodeCodePoints(left.fieldPath, right.fieldPath)
    || compareUnicodeCodePoints(left.referenceClaimId ?? "", right.referenceClaimId ?? "")
    || compareUnicodeCodePoints(left.rowId, right.rowId);
}

const FieldComparisonCommonShape = {
  comparisonId: ComparisonIdSchema,
  caseId: CaseIdSchema,
  subjectRevisionId: RevisionIdSchema,
  subjectRevisionContentFingerprint: Sha256FingerprintSchema,
  auditContentFingerprint: Sha256FingerprintSchema,
  chartsArtifactSha256: Sha256FingerprintSchema,
  referenceSetId: ReferenceSetIdSchema,
  referenceSetFingerprint: Sha256FingerprintSchema,
  rows: z.array(FieldComparisonRowV1Schema).min(1),
  comparisonFingerprint: Sha256FingerprintSchema
};

type ComparisonForRefinement = z.infer<z.ZodObject<typeof FieldComparisonCommonShape>> & {
  schemaVersion: "1.0.0" | "2.0.0";
  baziDetailFingerprint?: string;
  baziDetailArtifactSha256?: string;
};

function refineFieldComparison(
  comparison: ComparisonForRefinement,
  context: z.RefinementCtx
): void {
  const rowIds = new Set<string>();
  const rowFingerprints = new Set<string>();
  const rowRegistry = new Map<string, string>();
  comparison.rows.forEach((row, index) => {
    if (rowIds.has(row.rowId)) {
      context.addIssue({ code: "custom", message: "rowId 必须唯一", path: ["rows", index, "rowId"] });
    }
    if (rowFingerprints.has(row.rowFingerprint)) {
      context.addIssue({ code: "custom", message: "rowFingerprint 必须唯一", path: ["rows", index, "rowFingerprint"] });
    }
    rowIds.add(row.rowId);
    rowFingerprints.add(row.rowFingerprint);
    try {
      assertSemanticId({
        id: row.rowId,
        fingerprint: row.rowFingerprint,
        prefix: "ROW",
        registry: rowRegistry
      });
      rowRegistry.set(row.rowId, row.rowFingerprint);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "row 短 ID 碰撞",
        path: ["rows", index, "rowId"]
      });
    }
    if (index > 0 && compareRows(comparison.rows[index - 1], row) >= 0) {
      context.addIssue({
        code: "custom",
        message: "rows 必须按 candidateId/track/fieldPath/referenceClaimId 的 Unicode code point 规范顺序保存",
        path: ["rows", index]
      });
    }
  });

  const expectedFingerprint = computeFieldComparisonFingerprint(comparison as FieldComparison);
  try {
    assertSemanticId({
      id: comparison.comparisonId,
      fingerprint: comparison.comparisonFingerprint,
      prefix: "CMP",
      expectedFingerprint
    });
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "comparison 语义身份无效",
      path: ["comparisonId"]
    });
  }
  const derivedIdentity = deriveComparisonIdentity(expectedFingerprint);
  if (comparison.comparisonId !== derivedIdentity.id) {
    context.addIssue({
      code: "custom",
      message: "comparisonId 必须由重新派生的 comparisonFingerprint 产生",
      path: ["comparisonId"]
    });
  }
}

export const FieldComparisonV1Schema = z.object({
  schemaVersion: SchemaVersionV1Schema,
  ...FieldComparisonCommonShape
}).strict().superRefine(refineFieldComparison);

export const FieldComparisonV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  ...FieldComparisonCommonShape,
  baziDetailFingerprint: Sha256FingerprintSchema,
  baziDetailArtifactSha256: Sha256FingerprintSchema
}).strict().superRefine(refineFieldComparison);

export type FieldComparisonRowV1 = z.infer<typeof FieldComparisonRowV1Schema>;
export type FieldComparisonV1 = z.infer<typeof FieldComparisonV1Schema>;
export type FieldComparisonV2 = z.infer<typeof FieldComparisonV2Schema>;
export type FieldComparison = FieldComparisonV1 | FieldComparisonV2;
