import { z } from "zod";

import { AUDIT_CONTRACT_VERSION_V4, type AuditReportV2 } from "../audit/index.js";
import { BaziDetailV1Schema, type BaziDetailV1 } from "../charts/bazi-detail-contract.js";
import type { DualTrackChartSetV1 } from "../charts/types.js";
import type { PublicBirthRecordV2, TimeEvidenceV2 } from "../../shared/provided-time-contracts.js";
import {
  PROVIDED_TIME_APPROVED_REVISION_IDENTITY_V4,
  type ProvidedTimeDependencyIdentityV4,
  type ProvidedTimeRuleIdentityV4
} from "../workbench/revision-version-identity.js";
import type { WorkflowStatus } from "./case-store.js";
import { canonicalJson, sha256Bytes } from "./canonical.js";

export interface RevisionContentFingerprintInput {
  publicInput: Record<string, unknown>;
  timeEvidence: unknown;
  charts: unknown;
  audit: unknown;
  sourceImport?: { sha256: string; byteLength: number };
  calculationContext?: Record<string, unknown>;
  workflowStatus: string;
  auditContractVersion?: unknown;
  rules: Record<string, string>;
  dependencies: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripSemanticIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSemanticIdentifiers);
  if (!isObject(value)) return value;
  const omitted = new Set(["privateName", "revisionId", "chartBundleId", "auditReportId", "createdAt", "generatedAt"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !omitted.has(key))
    .map(([key, child]) => [key, stripSemanticIdentifiers(child)]));
}

export function computeRevisionContentFingerprint(input: RevisionContentFingerprintInput): string {
  return `sha256:${sha256Bytes(canonicalJson({
    input: stripSemanticIdentifiers(input.publicInput),
    timeEvidence: stripSemanticIdentifiers(input.timeEvidence),
    charts: stripSemanticIdentifiers(input.charts),
    audit: stripSemanticIdentifiers(input.audit),
    sourceImport: input.sourceImport,
    calculationContext: stripSemanticIdentifiers(input.calculationContext),
    workflowStatus: input.workflowStatus,
    ...(input.auditContractVersion === undefined ? {} : { auditContractVersion: input.auditContractVersion }),
    rules: input.rules,
    dependencies: input.dependencies
  }))}`;
}

export interface RevisionContentFingerprintV4Input {
  publicInput: PublicBirthRecordV2;
  timeEvidence: TimeEvidenceV2;
  charts: DualTrackChartSetV1;
  baziDetail: BaziDetailV1;
  audit: AuditReportV2;
  calculationContext: Record<string, unknown>;
  workflowStatus: WorkflowStatus;
  auditContractVersion: typeof AUDIT_CONTRACT_VERSION_V4;
  rules: ProvidedTimeRuleIdentityV4;
  dependencies: ProvidedTimeDependencyIdentityV4;
}

const presentValue = z.custom<unknown>((value) => value !== undefined, "V4 revision material value is required");
const RevisionContentFingerprintV4InputSchema = z.object({
  publicInput: presentValue,
  timeEvidence: presentValue,
  charts: presentValue,
  baziDetail: BaziDetailV1Schema,
  audit: presentValue,
  calculationContext: presentValue,
  workflowStatus: z.enum(["draft", "review", "verified", "void"]),
  auditContractVersion: z.literal(AUDIT_CONTRACT_VERSION_V4),
  rules: z.object({
    providedTime: z.literal(PROVIDED_TIME_APPROVED_REVISION_IDENTITY_V4.rules.providedTime),
    bazi: z.literal("CyberSaga-Bazi-v1"),
    baziDetail: z.literal("CyberSaga-Bazi-Detail-v1"),
    ziwei: z.literal("CyberSaga-Ziwei-v1"),
    audit: z.literal("CyberSaga-Audit-v2")
  }).strict(),
  dependencies: z.object({
    lunar: z.literal("lunar-typescript@1.8.6"),
    ziwei: z.literal("iztro@2.5.8"),
    canonicalization: z.literal("json-canonicalize@2.0.0")
  }).strict()
}).strict();

export function revisionContentFingerprintV4Material(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  raw: RevisionContentFingerprintV4Input
): Uint8Array {
  if (marker !== AUDIT_CONTRACT_VERSION_V4) throw new TypeError("V4_AUDIT_MARKER_REQUIRED");
  const input = RevisionContentFingerprintV4InputSchema.parse(raw);
  return new TextEncoder().encode(canonicalJson({
    input: stripSemanticIdentifiers(input.publicInput),
    timeEvidence: stripSemanticIdentifiers(input.timeEvidence),
    charts: stripSemanticIdentifiers(input.charts),
    baziDetail: stripSemanticIdentifiers(input.baziDetail),
    audit: stripSemanticIdentifiers(input.audit),
    calculationContext: stripSemanticIdentifiers(input.calculationContext),
    workflowStatus: input.workflowStatus,
    auditContractVersion: input.auditContractVersion,
    rules: input.rules,
    dependencies: input.dependencies
  }));
}

export function computeRevisionContentFingerprintV4(
  marker: typeof AUDIT_CONTRACT_VERSION_V4,
  input: RevisionContentFingerprintV4Input
): string {
  return `sha256:${sha256Bytes(revisionContentFingerprintV4Material(marker, input))}`;
}
