import { z } from "zod";

export const SchemaVersionV1Schema = z.literal("1.0.0");
export const CaseIdSchema = z.string().regex(/^CS-\d{4}-\d{3}$/u, "caseId 必须符合 CS-YYYY-NNN");
export const RevisionIdSchema = z.string().regex(/^R\d{3}$/u, "revisionId 必须符合 Rnnn");
export const ReferenceSetIdSchema = z.string().regex(/^REF\d{3}$/u, "referenceSetId 必须符合 REFnnn");
export const ReviewRevisionIdSchema = z.string().regex(/^RV\d{3}$/u, "reviewRevisionId 必须符合 RVnnn");
export const EvidenceIdSchema = z.string().regex(/^EVD-[0-9a-f]{16}$/u, "evidenceId 必须是 EVD- 加 16 位小写十六进制数");
export const ClaimIdSchema = z.string().regex(/^CLM-[0-9a-f]{16}$/u, "claimId 必须是 CLM- 加 16 位小写十六进制数");
export const RowIdSchema = z.string().regex(/^ROW-[0-9a-f]{16}$/u, "rowId 必须是 ROW- 加 16 位小写十六进制数");
export const ComparisonIdSchema = z.string().regex(/^CMP-[0-9a-f]{16}$/u, "comparisonId 必须是 CMP- 加 16 位小写十六进制数");
export const Sha256FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "SHA-256 必须使用 sha256: 前缀和 64 位小写十六进制数");
export const Rfc3339SecondSchema = z.iso.datetime({ offset: true, precision: 0 });
export const ReviewTrackSchema = z.enum(["time", "bazi", "ziwei"]);

export type ReviewJsonValue =
  | null
  | boolean
  | number
  | string
  | ReviewJsonValue[]
  | { [key: string]: ReviewJsonValue };

export const ReviewJsonValueSchema: z.ZodType<ReviewJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(ReviewJsonValueSchema),
  z.record(z.string(), ReviewJsonValueSchema)
]));

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}
