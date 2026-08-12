import { lstat, mkdir, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { z } from "zod";

import {
  AUDIT_CONTRACT_VERSION_V1,
  AUDIT_CONTRACT_VERSION_V2,
  AUDIT_CONTRACT_VERSION_V3,
  AUDIT_CONTRACT_VERSION_V4,
  AuditReportV1Schema,
  AuditReportV2Schema
} from "../audit/index.js";
import type { FieldComparison } from "../review/contracts/field-comparison.js";
import {
  FieldComparisonV1Schema,
  FieldComparisonV2Schema
} from "../review/contracts/field-comparison.js";
import type { HumanVerification } from "../review/contracts/human-verification.js";
import {
  HumanVerificationV1Schema,
  HumanVerificationV2Schema
} from "../review/contracts/human-verification.js";
import type { ReferenceEvidenceV1 } from "../review/contracts/reference-evidence.js";
import { compareRevisionToReference } from "../review/comparator.js";
import { ReviewError } from "../review/errors.js";
import { nextSequentialId } from "../review/ids.js";
import {
  COMPARISON_PROFILE_MANIFEST,
  FIELD_REGISTRY_MANIFEST,
  parseReviewRegistryIdentity,
  REFERENCE_KEYSET_MANIFEST,
  reviewRegistryIdentityForSubject
} from "../review/registry.js";
import { parseReviewSubject, type ReviewSubject } from "../review/subject-revision.js";
import { buildHumanVerification, deriveReviewSupersededView } from "../review/verification.js";
import { canonicalJson, sha256Bytes, writeCanonicalJson } from "./canonical.js";
import {
  assertDirectoryIdentities,
  assertOwnedTransientIdentity,
  captureDirectoryIdentities,
  collectArtifactTree,
  commitAtomicStagingDirectory,
  createAtomicStagingDirectory,
  isNodeError,
  manifestArtifactPathIsSafe,
  parseCanonicalJson,
  pathStatus,
  readStableRegularFile,
  removeOwnedReservation,
  removeOwnedStagingDirectory,
  reviewStorageError,
  safeReviewPath,
  syncDirectory,
  tryAcquireReservation,
  type DirectoryIdentity
} from "./review-store-filesystem.js";

const REVIEW_REVISION_ID_PATTERN = /^RV([0-9]{3})$/u;
const RESERVATION_PATTERN = /^\.(RV[0-9]{3})\.reserve$/u;
const STAGING_PATTERN = /^\.(RV[0-9]{3})\.tmp-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const EXPECTED_ARTIFACT_PATHS = ["comparison.json", "verification.json"] as const;
const RESERVATION_DEADLINE_MS = 2_000;
const RESERVATION_RETRY_MS = 10;

const REVIEW_RULES = Object.freeze({
  fieldRegistry: `${FIELD_REGISTRY_MANIFEST.version}#sha256:${FIELD_REGISTRY_MANIFEST.contentSha256}`,
  comparisonProfile: `${COMPARISON_PROFILE_MANIFEST.version}#sha256:${COMPARISON_PROFILE_MANIFEST.contentSha256}`,
  referenceKeyset: `${REFERENCE_KEYSET_MANIFEST.version}#sha256:${REFERENCE_KEYSET_MANIFEST.contentSha256}`,
  canonicalization: "json-canonicalize@2.0.0" as const
});

const ManifestFileSchema = z.object({
  path: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  private: z.literal(false)
}).strict();

const ReviewRevisionManifestV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("review_revision"),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  reviewRevisionId: z.string().regex(/^RV[0-9]{3}$/u),
  createdAt: z.iso.datetime({ offset: true, precision: 0 }),
  subjectRevisionId: z.string().regex(/^R[0-9]{3}$/u),
  subjectRevisionContentFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  auditContentFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  chartsArtifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  referenceSetId: z.string().regex(/^REF[0-9]{3}$/u),
  referenceSetFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  comparisonId: z.string().regex(/^CMP-[0-9a-f]{16}$/u),
  comparisonFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  verificationFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  previousVerificationFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  rules: z.object({
    fieldRegistry: z.string().min(1),
    comparisonProfile: z.string().min(1),
    referenceKeyset: z.string().min(1),
    canonicalization: z.literal(REVIEW_RULES.canonicalization)
  }).strict(),
  files: z.array(ManifestFileSchema)
}).strict().superRefine((manifest, context) => {
  if (parseReviewRegistryIdentity(manifest.rules) === null) {
    context.addIssue({ code: "custom", message: "review registry identity invalid", path: ["rules"] });
  }
});

const ReviewRevisionManifestV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  kind: z.literal("review_revision"),
  caseId: z.string().regex(/^CS-\d{4}-\d{3}$/u),
  reviewRevisionId: z.string().regex(/^RV[0-9]{3}$/u),
  createdAt: z.iso.datetime({ offset: true, precision: 0 }),
  subjectRevisionId: z.string().regex(/^R[0-9]{3}$/u),
  subjectRevisionContentFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  auditContentFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  chartsArtifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  baziDetailFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  baziDetailArtifactSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  referenceSetId: z.string().regex(/^REF[0-9]{3}$/u),
  referenceSetFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  comparisonId: z.string().regex(/^CMP-[0-9a-f]{16}$/u),
  comparisonFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  verificationFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  previousVerificationFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  rules: z.object({
    fieldRegistry: z.string().min(1),
    comparisonProfile: z.string().min(1),
    referenceKeyset: z.string().min(1),
    canonicalization: z.literal(REVIEW_RULES.canonicalization)
  }).strict(),
  files: z.array(ManifestFileSchema)
}).strict().superRefine((manifest, context) => {
  if (parseReviewRegistryIdentity(manifest.rules) === null) {
    context.addIssue({ code: "custom", message: "review registry identity invalid", path: ["rules"] });
  }
});

export interface ReviewRevisionManifestFileV1 {
  path: string;
  byteLength: number;
  sha256: string;
  private: false;
}

export interface ReviewRevisionManifestV1 {
  schemaVersion: "1.0.0";
  kind: "review_revision";
  caseId: string;
  reviewRevisionId: string;
  createdAt: string;
  subjectRevisionId: string;
  subjectRevisionContentFingerprint: string;
  auditContentFingerprint: string;
  chartsArtifactSha256: string;
  referenceSetId: string;
  referenceSetFingerprint: string;
  comparisonId: string;
  comparisonFingerprint: string;
  verificationFingerprint: string;
  previousVerificationFingerprint: string | null;
  rules: {
    fieldRegistry: string;
    comparisonProfile: string;
    referenceKeyset: string;
    canonicalization: "json-canonicalize@2.0.0";
  };
  files: ReviewRevisionManifestFileV1[];
}

export interface ReviewRevisionManifestV2 {
  schemaVersion: "2.0.0";
  kind: "review_revision";
  caseId: string;
  reviewRevisionId: string;
  createdAt: string;
  subjectRevisionId: string;
  subjectRevisionContentFingerprint: string;
  auditContentFingerprint: string;
  chartsArtifactSha256: string;
  baziDetailFingerprint: string;
  baziDetailArtifactSha256: string;
  referenceSetId: string;
  referenceSetFingerprint: string;
  comparisonId: string;
  comparisonFingerprint: string;
  verificationFingerprint: string;
  previousVerificationFingerprint: string | null;
  rules: ReviewRevisionManifestV1["rules"];
  files: ReviewRevisionManifestFileV1[];
}

export type ReviewRevisionManifest = ReviewRevisionManifestV1 | ReviewRevisionManifestV2;

export interface StoredReviewRevision {
  caseId: string;
  reviewRevisionId: string;
  directory: string;
  comparisonFingerprint: string;
  verificationFingerprint: string;
  createdAt: string;
}

export interface ReadReviewRevision extends StoredReviewRevision {
  comparison: FieldComparison;
  verification: HumanVerification;
  manifest: ReviewRevisionManifest;
  persistedStatus: HumanVerification["verificationStatus"];
  superseded: boolean;
}

export interface ReviewCaseStore {
  readRevision(
    caseId: string,
    revisionId: string,
    options?: { includePrivate?: boolean }
  ): Promise<Record<string, unknown>>;
  listCases(): Promise<Array<Record<string, unknown>>>;
}

export type ReviewRevisionFactory = (
  reviewRevisionId: string,
  previousVerificationFingerprint: string | null
) => Promise<{
  subject: ReviewSubject;
  comparison: FieldComparison;
  verification: HumanVerification;
}> | {
  subject: ReviewSubject;
  comparison: FieldComparison;
  verification: HumanVerification;
};

export interface ReviewRevisionStoreDependencies {
  rootDirectory: string;
  caseStore: ReviewCaseStore | undefined;
  readVerifiedReferenceSet(caseId: string, referenceSetId: string): Promise<ReferenceEvidenceV1>;
  beforeReviewCommit?: (reviewRevision: StoredReviewRevision) => void | Promise<void>;
}

interface ValidatedReviewRevision {
  stored: StoredReviewRevision;
  comparison: FieldComparison;
  verification: HumanVerification;
  manifest: ReviewRevisionManifest;
}

interface TransientEntry {
  id: string;
  kind: "reservation" | "staging";
}

interface ReviewLineageScan {
  committed: Map<string, ValidatedReviewRevision>;
  transients: TransientEntry[];
}

interface ReviewDirectoryBytes {
  comparison: Buffer;
  verification: Buffer;
  manifest: Buffer;
}

class RetryReviewAllocation extends Error {}
class RetryReviewLineageSnapshot extends Error {}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function exactFactoryShape(value: unknown): value is {
  subject: ReviewSubject;
  comparison: FieldComparison;
  verification: HumanVerification;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 3
    && keys[0] === "comparison"
    && keys[1] === "subject"
    && keys[2] === "verification";
}

function reviewOrdinal(reviewRevisionId: string): number {
  return Number(reviewRevisionId.slice(2));
}

export function assertReviewRevisionId(reviewRevisionId: unknown): asserts reviewRevisionId is string {
  const match = typeof reviewRevisionId === "string"
    ? REVIEW_REVISION_ID_PATTERN.exec(reviewRevisionId)
    : null;
  if (match === null || Number(match[1]) < 1) {
    throw reviewStorageError("INVALID_REVIEW_REVISION_ID", "复核修订编号必须符合 RVnnn", 422);
  }
}

function staleReviewInput(): ReviewError {
  return reviewStorageError("STALE_REVIEW_INPUT", "复核输入与当前权威内容不一致", 409);
}

function reviewStoreReentrant(error: unknown): ReviewError | undefined {
  if (
    error instanceof ReviewError
    && error.code === "REVIEW_STORE_REENTRANT"
    && error.statusCode === 409
  ) {
    return reviewStorageError(
      "REVIEW_STORE_REENTRANT",
      "同一案例的复核写操作不能从存储回调中重入",
      409
    );
  }
  return undefined;
}

async function normalizePublicReviewStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw reviewStorageError(
      "REVIEW_STORAGE_IO_FAILED",
      "复核修订存储操作失败",
      409
    );
  }
}

async function readReviewDirectoryBytes(directory: string): Promise<ReviewDirectoryBytes> {
  return {
    comparison: await readStableRegularFile(safeReviewPath(directory, "comparison.json")),
    verification: await readStableRegularFile(safeReviewPath(directory, "verification.json")),
    manifest: await readStableRegularFile(safeReviewPath(directory, "manifest.json"))
  };
}

function sameReviewDirectoryBytes(
  left: ReviewDirectoryBytes,
  right: ReviewDirectoryBytes
): boolean {
  return left.comparison.equals(right.comparison)
    && left.verification.equals(right.verification)
    && left.manifest.equals(right.manifest);
}

async function ensureReviewRevisionsDirectory(
  rootDirectory: string,
  caseId: string
): Promise<string> {
  let current = rootDirectory;
  for (const segment of ["reviews", caseId, "review-revisions"]) {
    const next = safeReviewPath(current, segment);
    let status = await pathStatus(next);
    if (status === undefined) {
      try {
        await mkdir(next, { mode: 0o700 });
        await syncDirectory(current);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      status = await lstat(next);
    }
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw reviewStorageError("UNSAFE_REVIEW_PATH", "复核存储目录不是安全的普通目录", 422);
    }
    current = next;
  }
  return current;
}

async function existingReviewRevisionsDirectory(
  rootDirectory: string,
  caseId: string
): Promise<string | undefined> {
  let current = rootDirectory;
  for (const segment of ["reviews", caseId, "review-revisions"]) {
    const next = safeReviewPath(current, segment);
    const status = await pathStatus(next);
    if (status === undefined) return undefined;
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw reviewStorageError("UNSAFE_REVIEW_PATH", "复核存储目录不是安全的普通目录", 422);
    }
    current = next;
  }
  return current;
}

async function captureReviewDirectoryChain(
  rootDirectory: string,
  caseId: string,
  reviewRevisionsDirectory: string
): Promise<DirectoryIdentity[]> {
  return captureDirectoryIdentities([
    rootDirectory,
    safeReviewPath(rootDirectory, "reviews"),
    safeReviewPath(rootDirectory, "reviews", caseId),
    reviewRevisionsDirectory
  ]);
}

async function rebuildAuthoritativeReviewArtifacts(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  reviewRevisionId: string,
  previousVerificationFingerprint: string | null,
  comparisonValue: unknown,
  verificationValue: unknown
): Promise<{
  subject: ReviewSubject;
  comparison: FieldComparison;
  verification: HumanVerification;
}> {
  const comparisonVersion = comparisonValue !== null && typeof comparisonValue === "object"
    ? (comparisonValue as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  const verificationVersion = verificationValue !== null && typeof verificationValue === "object"
    ? (verificationValue as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (comparisonVersion !== verificationVersion) throw staleReviewInput();
  const comparisonParse = comparisonVersion === "2.0.0"
    ? FieldComparisonV2Schema.safeParse(comparisonValue)
    : comparisonVersion === "1.0.0"
      ? FieldComparisonV1Schema.safeParse(comparisonValue)
      : undefined;
  const verificationParse = verificationVersion === "2.0.0"
    ? HumanVerificationV2Schema.safeParse(verificationValue)
    : verificationVersion === "1.0.0"
      ? HumanVerificationV1Schema.safeParse(verificationValue)
      : undefined;
  if (comparisonParse === undefined || verificationParse === undefined
    || !comparisonParse.success || !verificationParse.success) throw staleReviewInput();
  const comparison = comparisonParse.data as FieldComparison;
  const verification = verificationParse.data as HumanVerification;
  const caseStore = dependencies.caseStore;
  if (caseStore === undefined) {
    throw reviewStorageError("REVIEW_CASE_STORE_REQUIRED", "创建复核修订必须配置核心案例存储", 422);
  }
  try {
    const snapshot = await caseStore.readRevision(caseId, comparison.subjectRevisionId);
    const subject = parseReviewSubject(snapshot);
    const reference = await dependencies.readVerifiedReferenceSet(caseId, comparison.referenceSetId);
    const officialComparison = await compareRevisionToReference({ subject, reference });
    if (canonicalJson(officialComparison) !== canonicalJson(comparison)) throw staleReviewInput();
    const rebuiltVerification = buildHumanVerification({
      reviewRevisionId,
      comparison: officialComparison,
      reference,
      audit: subject.audit,
      decisions: verification.decisions,
      ...(previousVerificationFingerprint === null
        ? {}
        : { previousVerificationFingerprint }),
      recordedAt: verification.recordedAt,
      verifiedAt: verification.verifiedAt
    });
    if (canonicalJson(rebuiltVerification) !== canonicalJson(verification)) throw staleReviewInput();
    return { subject, comparison: officialComparison, verification: rebuiltVerification };
  } catch (error) {
    if (error instanceof ReviewError && error.code === "REVIEW_CASE_STORE_REQUIRED") throw error;
    throw staleReviewInput();
  }
}

async function authoritativeFactoryArtifacts(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  reviewRevisionId: string,
  previousVerificationFingerprint: string | null,
  created: unknown
): Promise<{
  subject: ReviewSubject;
  comparison: FieldComparison;
  verification: HumanVerification;
}> {
  try {
    if (!exactFactoryShape(created)) throw staleReviewInput();
    const authoritative = await rebuildAuthoritativeReviewArtifacts(
      dependencies,
      caseId,
      reviewRevisionId,
      previousVerificationFingerprint,
      created.comparison,
      created.verification
    );
    if (canonicalJson(authoritative.subject) !== canonicalJson(created.subject)) {
      throw staleReviewInput();
    }
    return authoritative;
  } catch (error) {
    if (error instanceof ReviewError && error.code === "REVIEW_CASE_STORE_REQUIRED") throw error;
    throw staleReviewInput();
  }
}

function manifestFor(
  caseId: string,
  reviewRevisionId: string,
  previousVerificationFingerprint: string | null,
  artifacts: {
    subject: ReviewSubject;
    comparison: FieldComparison;
    verification: HumanVerification;
  },
  files: ReviewRevisionManifestFileV1[]
): ReviewRevisionManifest {
  const registry = reviewRegistryIdentityForSubject(artifacts.subject);
  const common = {
    kind: "review_revision" as const,
    caseId,
    reviewRevisionId,
    createdAt: artifacts.verification.recordedAt,
    subjectRevisionId: artifacts.subject.revisionId,
    subjectRevisionContentFingerprint: artifacts.subject.revisionContentFingerprint,
    auditContentFingerprint: artifacts.subject.auditContentFingerprint,
    chartsArtifactSha256: artifacts.subject.chartsArtifactSha256,
    referenceSetId: artifacts.comparison.referenceSetId,
    referenceSetFingerprint: artifacts.comparison.referenceSetFingerprint,
    comparisonId: artifacts.comparison.comparisonId,
    comparisonFingerprint: artifacts.comparison.comparisonFingerprint,
    verificationFingerprint: artifacts.verification.verificationFingerprint,
    previousVerificationFingerprint,
    rules: {
      fieldRegistry: registry.fieldRegistry,
      comparisonProfile: registry.comparisonProfile,
      referenceKeyset: registry.referenceKeyset,
      canonicalization: REVIEW_RULES.canonicalization
    },
    files
  };
  if (
    artifacts.subject.subjectContract === "provided_time_detail_v3"
    && artifacts.comparison.schemaVersion === "2.0.0"
    && artifacts.verification.schemaVersion === "2.0.0"
  ) {
    return {
      schemaVersion: "2.0.0",
      ...common,
      baziDetailFingerprint: artifacts.subject.baziDetailFingerprint,
      baziDetailArtifactSha256: artifacts.subject.baziDetailArtifactSha256
    };
  }
  if (artifacts.comparison.schemaVersion !== "1.0.0" || artifacts.verification.schemaVersion !== "1.0.0") {
    throw staleReviewInput();
  }
  return { schemaVersion: "1.0.0", ...common };
}

async function verifyReviewDirectory(
  dependencies: ReviewRevisionStoreDependencies,
  directory: string,
  expectedCaseId: string,
  expectedReviewRevisionId: string,
  expectedPreviousVerificationFingerprint: string | null,
  preserveStaleInput = false
): Promise<ValidatedReviewRevision> {
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("invalid review directory");
    const manifestValue = parseCanonicalJson(
      await readStableRegularFile(safeReviewPath(directory, "manifest.json"))
    );
    const manifestVersion = manifestValue !== null && typeof manifestValue === "object"
      ? (manifestValue as { schemaVersion?: unknown }).schemaVersion
      : undefined;
    const manifestParse = manifestVersion === "2.0.0"
      ? ReviewRevisionManifestV2Schema.safeParse(manifestValue)
      : manifestVersion === "1.0.0"
        ? ReviewRevisionManifestV1Schema.safeParse(manifestValue)
        : undefined;
    if (manifestParse === undefined || !manifestParse.success) throw new Error("invalid review manifest");
    const manifest = manifestParse.data as ReviewRevisionManifest;
    if (
      manifest.caseId !== expectedCaseId
      || manifest.reviewRevisionId !== expectedReviewRevisionId
      || manifest.previousVerificationFingerprint !== expectedPreviousVerificationFingerprint
    ) throw new Error("review manifest identity mismatch");
    const manifestPaths = manifest.files.map((file) => file.path);
    if (
      manifestPaths.some((path) => !manifestArtifactPathIsSafe(path))
      || new Set(manifestPaths).size !== manifestPaths.length
      || canonicalJson(manifestPaths) !== canonicalJson(EXPECTED_ARTIFACT_PATHS)
    ) throw new Error("review manifest paths invalid");
    const tree = await collectArtifactTree(directory);
    if (canonicalJson(tree.files) !== canonicalJson(EXPECTED_ARTIFACT_PATHS) || tree.directories.length !== 0) {
      throw new Error("review artifact tree mismatch");
    }
    const bytes = new Map<string, Buffer>();
    for (const file of manifest.files) {
      const artifactBytes = await readStableRegularFile(safeReviewPath(directory, file.path));
      if (
        artifactBytes.byteLength !== file.byteLength
        || `sha256:${sha256Bytes(artifactBytes)}` !== file.sha256
      ) throw new Error("review artifact hash mismatch");
      bytes.set(file.path, artifactBytes);
    }
    const comparisonValue = parseCanonicalJson(bytes.get("comparison.json")!);
    const verificationValue = parseCanonicalJson(bytes.get("verification.json")!);
    const authoritative = await rebuildAuthoritativeReviewArtifacts(
      dependencies,
      expectedCaseId,
      expectedReviewRevisionId,
      expectedPreviousVerificationFingerprint,
      comparisonValue,
      verificationValue
    );
    const expectedManifest = manifestFor(
      expectedCaseId,
      expectedReviewRevisionId,
      expectedPreviousVerificationFingerprint,
      authoritative,
      manifest.files
    );
    if (canonicalJson(expectedManifest) !== canonicalJson(manifest)) {
      throw new Error("review manifest semantic binding mismatch");
    }
    return {
      stored: {
        caseId: expectedCaseId,
        reviewRevisionId: expectedReviewRevisionId,
        directory,
        comparisonFingerprint: authoritative.comparison.comparisonFingerprint,
        verificationFingerprint: authoritative.verification.verificationFingerprint,
        createdAt: authoritative.verification.recordedAt
      },
      comparison: authoritative.comparison,
      verification: authoritative.verification,
      manifest
    };
  } catch (error) {
    if (
      preserveStaleInput
      && error instanceof ReviewError
      && error.code === "STALE_REVIEW_INPUT"
    ) throw error;
    throw reviewStorageError("REVIEW_REVISION_CORRUPT", "已提交复核修订未通过完整性校验", 409);
  }
}

async function scanReviewLineageSnapshot(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  allowTransients: boolean
): Promise<ReviewLineageScan> {
  const parent = await existingReviewRevisionsDirectory(dependencies.rootDirectory, caseId);
  if (parent === undefined) return { committed: new Map(), transients: [] };
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "无法安全读取复核修订链", 409);
  }
  const ids: string[] = [];
  const transients: TransientEntry[] = [];
  for (const name of names) {
    const idMatch = REVIEW_REVISION_ID_PATTERN.exec(name);
    if (idMatch !== null && Number(idMatch[1]) >= 1) {
      ids.push(name);
      continue;
    }
    const reservationMatch = RESERVATION_PATTERN.exec(name);
    const stagingMatch = STAGING_PATTERN.exec(name);
    if (reservationMatch === null && stagingMatch === null) {
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订链包含无法识别的条目", 409);
    }
    const id = (reservationMatch ?? stagingMatch)![1];
    let status;
    try {
      status = await lstat(safeReviewPath(parent, name));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") throw new RetryReviewLineageSnapshot();
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订暂存条目无法安全读取", 409);
    }
    const regular = reservationMatch !== null
      ? status.isFile() && !status.isSymbolicLink()
      : status.isDirectory() && !status.isSymbolicLink();
    if (!regular) {
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订链包含不安全的暂存条目", 409);
    }
    transients.push({ id, kind: reservationMatch !== null ? "reservation" : "staging" });
  }
  ids.sort((left, right) => reviewOrdinal(left) - reviewOrdinal(right));
  for (let index = 0; index < ids.length; index += 1) {
    if (ids[index] !== `RV${String(index + 1).padStart(3, "0")}`) {
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订编号链不连续", 409);
    }
  }
  const committed = new Map<string, ValidatedReviewRevision>();
  let previous: string | null = null;
  for (const id of ids) {
    const validated = await verifyReviewDirectory(
      dependencies,
      safeReviewPath(parent, id),
      caseId,
      id,
      previous
    );
    committed.set(id, validated);
    previous = validated.verification.verificationFingerprint;
  }
  const reservationIds = new Set(
    transients.filter((entry) => entry.kind === "reservation").map((entry) => entry.id)
  );
  const stagingCounts = new Map<string, number>();
  for (const entry of transients) {
    if (entry.kind !== "staging") continue;
    stagingCounts.set(entry.id, (stagingCounts.get(entry.id) ?? 0) + 1);
    if (committed.has(entry.id) || !reservationIds.has(entry.id) || stagingCounts.get(entry.id)! > 1) {
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订链包含未完成的暂存目录", 409);
    }
  }
  const active = transients.filter((entry) => !committed.has(entry.id));
  if (!allowTransients && active.length > 0) {
    throw reviewStorageError("REVIEW_REVISION_BUSY", "复核修订目录存在尚未完成的写操作", 409);
  }
  return { committed, transients };
}

async function scanReviewLineage(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  allowTransients: boolean
): Promise<ReviewLineageScan> {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    try {
      return await scanReviewLineageSnapshot(dependencies, caseId, allowTransients);
    } catch (error) {
      if (!(error instanceof RetryReviewLineageSnapshot)) throw error;
    }
  }
  throw reviewStorageError("REVIEW_REVISION_BUSY", "复核修订目录在读取期间持续变化", 409);
}

async function createReviewRevisionStorageUnchecked(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  factory: ReviewRevisionFactory
): Promise<StoredReviewRevision> {
  if (typeof factory !== "function") {
    throw reviewStorageError("REVIEW_FACTORY_INVALID", "复核修订工厂无效", 422);
  }
  const parent = await ensureReviewRevisionsDirectory(dependencies.rootDirectory, caseId);
  const chain = await captureReviewDirectoryChain(dependencies.rootDirectory, caseId, parent);
  const deadline = performance.now() + RESERVATION_DEADLINE_MS;
  while (true) {
    await assertDirectoryIdentities(chain);
    const scan = await scanReviewLineage(dependencies, caseId, true);
    const reviewRevisionId = nextSequentialId("RV", [...scan.committed.keys()]);
    const blocking = scan.transients.filter((entry) => (
      entry.id === reviewRevisionId || !scan.committed.has(entry.id)
    ));
    if (blocking.some((entry) => entry.id !== reviewRevisionId)) {
      throw reviewStorageError("REVIEW_LINEAGE_CORRUPT", "复核修订链包含无法识别的暂存条目", 409);
    }
    if (blocking.length > 0) {
      if (performance.now() >= deadline) {
        throw reviewStorageError("REVIEW_REVISION_BUSY", "下一复核修订编号正由其他写操作占用", 409);
      }
      await delay(RESERVATION_RETRY_MS);
      continue;
    }
    const reservationPath = safeReviewPath(parent, `.${reviewRevisionId}.reserve`);
    const acquired = await tryAcquireReservation(reservationPath, parent, chain);
    if (acquired === undefined) {
      if (performance.now() >= deadline) {
        throw reviewStorageError("REVIEW_REVISION_BUSY", "下一复核修订编号正由其他写操作占用", 409);
      }
      await delay(RESERVATION_RETRY_MS);
      continue;
    }
    try {
      const refreshed = await scanReviewLineage(dependencies, caseId, true);
      if (nextSequentialId("RV", [...refreshed.committed.keys()]) !== reviewRevisionId) {
        throw new RetryReviewAllocation();
      }
      const previousVerificationFingerprint = refreshed.committed.size === 0
        ? null
        : [...refreshed.committed.values()].at(-1)!.verification.verificationFingerprint;
      let created: Awaited<ReturnType<ReviewRevisionFactory>>;
      try {
        created = await factory(reviewRevisionId, previousVerificationFingerprint);
      } catch (error) {
        const reentrant = reviewStoreReentrant(error);
        if (reentrant !== undefined) throw reentrant;
        throw reviewStorageError("REVIEW_FACTORY_FAILED", "复核修订工厂执行失败", 422);
      }
      await assertOwnedTransientIdentity(acquired, chain);
      const authoritative = await authoritativeFactoryArtifacts(
        dependencies,
        caseId,
        reviewRevisionId,
        previousVerificationFingerprint,
        created
      );
      const targetDirectory = safeReviewPath(parent, reviewRevisionId);
      if (await pathStatus(targetDirectory) !== undefined) throw new RetryReviewAllocation();
      await assertDirectoryIdentities(chain);
      const staging = await createAtomicStagingDirectory(parent, reviewRevisionId);
      const stagingDirectory = staging.path;
      try {
        await writeCanonicalJson(safeReviewPath(stagingDirectory, "comparison.json"), authoritative.comparison);
        await writeCanonicalJson(safeReviewPath(stagingDirectory, "verification.json"), authoritative.verification);
        const files: ReviewRevisionManifestFileV1[] = [];
        for (const artifactPath of EXPECTED_ARTIFACT_PATHS) {
          const artifactBytes = await readStableRegularFile(safeReviewPath(stagingDirectory, artifactPath));
          files.push({
            path: artifactPath,
            byteLength: artifactBytes.byteLength,
            sha256: `sha256:${sha256Bytes(artifactBytes)}`,
            private: false
          });
        }
        const manifest = manifestFor(
          caseId,
          reviewRevisionId,
          previousVerificationFingerprint,
          authoritative,
          files
        );
        await writeCanonicalJson(safeReviewPath(stagingDirectory, "manifest.json"), manifest);
        const beforeHook = await verifyReviewDirectory(
          dependencies,
          stagingDirectory,
          caseId,
          reviewRevisionId,
          previousVerificationFingerprint,
          true
        );
        const expectedBytes = await readReviewDirectoryBytes(stagingDirectory);
        await syncDirectory(stagingDirectory);
        const hookView: StoredReviewRevision = {
          caseId,
          reviewRevisionId,
          directory: targetDirectory,
          comparisonFingerprint: beforeHook.comparison.comparisonFingerprint,
          verificationFingerprint: beforeHook.verification.verificationFingerprint,
          createdAt: beforeHook.verification.recordedAt
        };
        if (dependencies.beforeReviewCommit !== undefined) {
          try {
            await dependencies.beforeReviewCommit(Object.freeze(structuredClone(hookView)));
          } catch (error) {
            const reentrant = reviewStoreReentrant(error);
            if (reentrant !== undefined) throw reentrant;
            throw reviewStorageError("REVIEW_COMMIT_HOOK_FAILED", "复核修订提交钩子执行失败", 409);
          }
        }
        await assertDirectoryIdentities(chain);
        await assertOwnedTransientIdentity(acquired, chain);
        await assertOwnedTransientIdentity(staging, chain);
        const lineageAfterHook = await scanReviewLineage(dependencies, caseId, true);
        if (nextSequentialId("RV", [...lineageAfterHook.committed.keys()]) !== reviewRevisionId) {
          throw new RetryReviewAllocation();
        }
        const validatedAfterHook = await verifyReviewDirectory(
          dependencies,
          stagingDirectory,
          caseId,
          reviewRevisionId,
          previousVerificationFingerprint,
          true
        );
        const actualBytes = await readReviewDirectoryBytes(stagingDirectory);
        if (
          !sameReviewDirectoryBytes(expectedBytes, actualBytes)
          || canonicalJson(validatedAfterHook.comparison) !== canonicalJson(beforeHook.comparison)
          || canonicalJson(validatedAfterHook.verification) !== canonicalJson(beforeHook.verification)
          || canonicalJson(validatedAfterHook.manifest) !== canonicalJson(beforeHook.manifest)
        ) throw staleReviewInput();
        if (await pathStatus(targetDirectory) !== undefined) throw new RetryReviewAllocation();
        try {
          await commitAtomicStagingDirectory(staging, targetDirectory, chain);
        } catch (error) {
          if (isNodeError(error) && ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
            throw new RetryReviewAllocation();
          }
          throw error;
        }
        const stored: StoredReviewRevision = {
          ...validatedAfterHook.stored,
          directory: targetDirectory
        };
        return structuredClone(stored);
      } catch (error) {
        await removeOwnedStagingDirectory(staging, chain);
        throw error;
      }
    } catch (error) {
      if (error instanceof RetryReviewAllocation) continue;
      throw error;
    } finally {
      await removeOwnedReservation(acquired, chain);
    }
  }
}

async function subjectRevisionIsLatestDecision(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  subjectRevisionId: string
): Promise<boolean> {
  const caseStore = dependencies.caseStore;
  if (caseStore === undefined) {
    throw reviewStorageError("REVIEW_CASE_STORE_REQUIRED", "读取复核修订必须配置核心案例存储", 422);
  }
  try {
    const cases = await caseStore.listCases();
    const row = cases.find((candidate) => candidate.caseId === caseId);
    if (row === undefined || typeof row.latestRevisionId !== "string" || !/^R[0-9]{3}$/u.test(row.latestRevisionId)) {
      throw new Error("latest core revision identity invalid");
    }
    const subjectOrdinal = Number(subjectRevisionId.slice(1));
    const latestOrdinal = Number(row.latestRevisionId.slice(1));
    if (latestOrdinal < subjectOrdinal) throw new Error("latest core revision precedes subject");
    for (let ordinal = subjectOrdinal + 1; ordinal <= latestOrdinal; ordinal += 1) {
      const revisionId = `R${String(ordinal).padStart(3, "0")}`;
      const snapshot = await caseStore.readRevision(caseId, revisionId);
      const marker = snapshot.manifest !== null && typeof snapshot.manifest === "object"
        ? (snapshot.manifest as { auditContractVersion?: unknown }).auditContractVersion
        : undefined;
      const auditParse = marker === AUDIT_CONTRACT_VERSION_V4
        ? AuditReportV2Schema.safeParse(snapshot.audit)
        : marker === undefined
          || marker === AUDIT_CONTRACT_VERSION_V1
          || marker === AUDIT_CONTRACT_VERSION_V2
          || marker === AUDIT_CONTRACT_VERSION_V3
          ? AuditReportV1Schema.safeParse(snapshot.audit)
          : undefined;
      if (auditParse === undefined || !auditParse.success
        || auditParse.data.caseId !== caseId || auditParse.data.revisionId !== revisionId) {
        throw new Error("later core audit invalid");
      }
      if (auditParse.data.manualDecision.status !== "none") return false;
    }
    return true;
  } catch (error) {
    if (error instanceof ReviewError && error.code === "REVIEW_CASE_STORE_REQUIRED") throw error;
    throw reviewStorageError("REVIEW_REVISION_CORRUPT", "复核修订的后续核心决定无法验证", 409);
  }
}

async function readView(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  entry: ValidatedReviewRevision,
  hasSuccessorVerification: boolean
): Promise<ReadReviewRevision> {
  const latestDecision = await subjectRevisionIsLatestDecision(
    dependencies,
    caseId,
    entry.manifest.subjectRevisionId
  );
  const view = deriveReviewSupersededView({
    verification: entry.verification,
    hasSuccessorVerification,
    subjectRevisionIsLatestDecision: latestDecision
  });
  return {
    ...structuredClone(entry.stored),
    comparison: structuredClone(entry.comparison),
    verification: structuredClone(entry.verification),
    manifest: structuredClone(entry.manifest),
    ...view
  };
}

async function readReviewRevisionStorageUnchecked(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  reviewRevisionId: string
): Promise<ReadReviewRevision> {
  assertReviewRevisionId(reviewRevisionId);
  const scan = await scanReviewLineage(dependencies, caseId, false);
  const entry = scan.committed.get(reviewRevisionId);
  if (entry === undefined) {
    throw reviewStorageError("REVIEW_REVISION_NOT_FOUND", "复核修订不存在", 404);
  }
  return readView(
    dependencies,
    caseId,
    entry,
    reviewOrdinal(reviewRevisionId) < scan.committed.size
  );
}

async function listReviewRevisionsStorageUnchecked(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string
): Promise<ReadReviewRevision[]> {
  const scan = await scanReviewLineage(dependencies, caseId, false);
  const values = [...scan.committed.values()];
  return Promise.all(values.map((entry, index) => readView(
    dependencies,
    caseId,
    entry,
    index < values.length - 1
  )));
}

export async function createReviewRevisionStorage(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  factory: ReviewRevisionFactory
): Promise<StoredReviewRevision> {
  return normalizePublicReviewStorage(() => (
    createReviewRevisionStorageUnchecked(dependencies, caseId, factory)
  ));
}

export async function readReviewRevisionStorage(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string,
  reviewRevisionId: string
): Promise<ReadReviewRevision> {
  return normalizePublicReviewStorage(() => (
    readReviewRevisionStorageUnchecked(dependencies, caseId, reviewRevisionId)
  ));
}

export async function listReviewRevisionsStorage(
  dependencies: ReviewRevisionStoreDependencies,
  caseId: string
): Promise<ReadReviewRevision[]> {
  return normalizePublicReviewStorage(() => (
    listReviewRevisionsStorageUnchecked(dependencies, caseId)
  ));
}
