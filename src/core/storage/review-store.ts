import { AsyncLocalStorage } from "node:async_hooks";
import {
  lstat,
  mkdir,
  readdir,
  realpath
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

import {
  ReferenceEvidenceV1Schema,
  type ReferenceEvidenceV1
} from "../review/contracts/reference-evidence.js";
import { compareUnicodeCodePoints } from "../review/contracts/common.js";
import { ReviewError } from "../review/errors.js";
import { nextSequentialId } from "../review/ids.js";
import { assertReferenceEvidencePublicPrivacy } from "../review/public-semantic-privacy.js";
import {
  type PrivateSourceLocationV1,
  verifyReferenceSource
} from "../review/reference-inspector.js";
import {
  bindReferenceRegistryIdentity,
  COMPARISON_PROFILE_MANIFEST,
  FIELD_REGISTRY_MANIFEST,
  parseReviewRegistryIdentity,
  REFERENCE_KEYSET_MANIFEST,
  referenceRegistryIdentityForFingerprint
} from "../review/registry.js";
import { canonicalJson, sha256Bytes, writeCanonicalJson } from "./canonical.js";
import {
  assertDirectoryIdentities,
  assertOwnedTransientIdentity,
  canonicalExistingDirectory,
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
  type DirectoryIdentity,
  type OwnedReservationIdentity
} from "./review-store-filesystem.js";
import {
  createReviewRevisionStorage,
  listReviewRevisionsStorage,
  readReviewRevisionStorage,
  type ReadReviewRevision,
  type ReviewCaseStore,
  type ReviewRevisionFactory,
  type ReviewRevisionManifest,
  type ReviewRevisionManifestFileV1,
  type ReviewRevisionManifestV1,
  type ReviewRevisionManifestV2,
  type StoredReviewRevision
} from "./review-revision-store.js";

export type {
  ReadReviewRevision,
  ReviewCaseStore,
  ReviewRevisionManifest,
  ReviewRevisionManifestFileV1,
  ReviewRevisionManifestV1,
  ReviewRevisionManifestV2,
  StoredReviewRevision
} from "./review-revision-store.js";

const CASE_ID_PATTERN = /^CS-\d{4}-\d{3}$/u;
const REFERENCE_SET_ID_PATTERN = /^REF([0-9]{3})$/u;
const EVIDENCE_ID_PATTERN = /^EVD-[0-9a-f]{16}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_MEDIA_TYPES = new Set(["text/plain", "image/png", "image/jpeg", "application/json"]);
const RESERVATION_PATTERN = /^\.(REF[0-9]{3})\.reserve$/u;
const STAGING_PATTERN = /^\.(REF[0-9]{3})\.tmp-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const EXPECTED_ARTIFACT_PATHS = ["private/source-locations.json", "reference-evidence.json"] as const;
const EXPECTED_DIRECTORY_PATHS = ["private"] as const;
const RESERVATION_DEADLINE_MS = 2_000;
const RESERVATION_RETRY_MS = 10;

interface ReviewStoreCallbackScope {
  readonly key: string;
  active: boolean;
}

const reviewStoreCallbackScopes = new AsyncLocalStorage<readonly ReviewStoreCallbackScope[]>();

const REFERENCE_RULES = Object.freeze({
  fieldRegistry: `${FIELD_REGISTRY_MANIFEST.version}#sha256:${FIELD_REGISTRY_MANIFEST.contentSha256}`,
  comparisonProfile: `${COMPARISON_PROFILE_MANIFEST.version}#sha256:${COMPARISON_PROFILE_MANIFEST.contentSha256}`,
  referenceKeyset: `${REFERENCE_KEYSET_MANIFEST.version}#sha256:${REFERENCE_KEYSET_MANIFEST.contentSha256}`,
  canonicalization: "json-canonicalize@2.0.0" as const
});

export interface ReferenceSetManifestFileV1 {
  path: string;
  byteLength: number;
  sha256: string;
  private: boolean;
}

export interface ReferenceSetManifestV1 {
  schemaVersion: "1.0.0";
  kind: "reference_set";
  caseId: string;
  referenceSetId: string;
  createdAt: string;
  semanticFingerprint: string;
  rules: {
    fieldRegistry: string;
    comparisonProfile: string;
    referenceKeyset: string;
    canonicalization: "json-canonicalize@2.0.0";
  };
  files: ReferenceSetManifestFileV1[];
}

export interface StoredReferenceSet {
  caseId: string;
  referenceSetId: string;
  directory: string;
  semanticFingerprint: string;
  createdAt: string;
}

export interface ReadReferenceSet {
  evidence: ReferenceEvidenceV1;
  manifest: ReferenceSetManifestV1;
  privateLocations?: PrivateSourceLocationV1[];
}

export interface ReviewStoreOptions {
  now?: () => Date;
  beforeReferenceCommit?: (referenceSet: StoredReferenceSet) => void | Promise<void>;
  beforeReviewCommit?: (reviewRevision: StoredReviewRevision) => void | Promise<void>;
  caseStore?: ReviewCaseStore;
  referenceSourceRoots: readonly string[];
}

interface JsonObject {
  [key: string]: unknown;
}

interface ValidatedReferenceSet {
  stored: StoredReferenceSet;
  evidence: ReferenceEvidenceV1;
  privateLocations: PrivateSourceLocationV1[];
  manifest: ReferenceSetManifestV1;
}

interface TransientEntry {
  id: string;
  kind: "reservation" | "staging";
  name: string;
}

interface LineageScan {
  committed: Map<string, ValidatedReferenceSet>;
  transients: TransientEntry[];
}

class RetryReferenceAllocation extends Error {}
class RetryLineageSnapshot extends Error {}

function reviewError(
  code: string,
  message: string,
  statusCode: 400 | 404 | 409 | 413 | 415 | 422
): ReviewError {
  return reviewStorageError(code, message, statusCode);
}

function reviewStoreReentrant(): ReviewError {
  return reviewError(
    "REVIEW_STORE_REENTRANT",
    "同一案例的复核写操作不能从存储回调中重入",
    409
  );
}

function isReviewStoreReentrant(error: unknown): error is ReviewError {
  return error instanceof ReviewError
    && error.code === "REVIEW_STORE_REENTRANT"
    && error.statusCode === 409;
}

async function normalizePublicReferenceStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw reviewError(
      "REFERENCE_STORAGE_IO_FAILED",
      "参考集存储操作失败",
      409
    );
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUnicodeCodePoints);
  const wanted = [...expected].sort(compareUnicodeCodePoints);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertCaseId(caseId: unknown): asserts caseId is string {
  if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
    throw reviewError("INVALID_CASE_ID", "案例编号必须符合 CS-YYYY-NNN", 422);
  }
}

function assertReferenceSetId(referenceSetId: unknown): asserts referenceSetId is string {
  const match = typeof referenceSetId === "string" ? REFERENCE_SET_ID_PATTERN.exec(referenceSetId) : null;
  if (match === null || Number(match[1]) < 1) {
    throw reviewError("INVALID_REFERENCE_SET_ID", "参考集编号必须符合 REFnnn", 422);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const boundary = relative(root, candidate);
  return boundary === "" || (
    boundary !== ".."
    && !boundary.startsWith(`..${sep}`)
    && !isAbsolute(boundary)
  );
}

function safePath(baseDirectory: string, ...segments: string[]): string {
  return safeReviewPath(baseDirectory, ...segments);
}

function referenceOrdinal(referenceSetId: string): number {
  return Number(referenceSetId.slice(3));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertReadOptions(value: unknown): asserts value is { includePrivate?: boolean } {
  if (
    value === undefined
    || (
      isObject(value)
      && exactKeys(value, Object.prototype.hasOwnProperty.call(value, "includePrivate") ? ["includePrivate"] : [])
      && (value.includePrivate === undefined || typeof value.includePrivate === "boolean")
    )
  ) return;
  throw reviewError("REFERENCE_READ_OPTIONS_INVALID", "参考集读取选项无效", 422);
}

function assertReviewStoreOptions(value: unknown): asserts value is ReviewStoreOptions {
  const allowedKeys = new Set([
    "now",
    "beforeReferenceCommit",
    "beforeReviewCommit",
    "caseStore",
    "referenceSourceRoots"
  ]);
  if (
    !isObject(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !Object.prototype.hasOwnProperty.call(value, "referenceSourceRoots")
    || !Array.isArray(value.referenceSourceRoots)
    || value.referenceSourceRoots.length === 0
    || (value.now !== undefined && typeof value.now !== "function")
    || (value.beforeReferenceCommit !== undefined && typeof value.beforeReferenceCommit !== "function")
    || (value.beforeReviewCommit !== undefined && typeof value.beforeReviewCommit !== "function")
    || (
      value.caseStore !== undefined
      && (
        !isObject(value.caseStore)
        || typeof value.caseStore.readRevision !== "function"
        || typeof value.caseStore.listCases !== "function"
      )
    )
  ) {
    throw reviewError("REVIEW_STORE_OPTIONS_INVALID", "复核存储配置无效", 422);
  }
}

function assertPrivateLocation(value: unknown): asserts value is PrivateSourceLocationV1 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      "schemaVersion",
      "evidenceId",
      "sourcePath",
      "contentSha256",
      "byteLength",
      "mediaType"
    ])
    || value.schemaVersion !== "1.0.0"
    || typeof value.evidenceId !== "string"
    || !EVIDENCE_ID_PATTERN.test(value.evidenceId)
    || typeof value.sourcePath !== "string"
    || value.sourcePath.includes("\0")
    || !isAbsolute(value.sourcePath)
    || typeof value.contentSha256 !== "string"
    || !SHA256_PATTERN.test(value.contentSha256)
    || !Number.isSafeInteger(value.byteLength)
    || (value.byteLength as number) < 0
    || typeof value.mediaType !== "string"
    || !SOURCE_MEDIA_TYPES.has(value.mediaType)
  ) {
    throw new Error("invalid private source location");
  }
}

function parsePrivateLocations(value: unknown): PrivateSourceLocationV1[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid private source locations");
  for (const location of value) assertPrivateLocation(location);
  return structuredClone(value);
}

function assertManifest(value: unknown): asserts value is ReferenceSetManifestV1 {
  if (
    !isObject(value)
    || !exactKeys(value, [
      "schemaVersion",
      "kind",
      "caseId",
      "referenceSetId",
      "createdAt",
      "semanticFingerprint",
      "rules",
      "files"
    ])
    || value.schemaVersion !== "1.0.0"
    || value.kind !== "reference_set"
    || typeof value.caseId !== "string"
    || typeof value.referenceSetId !== "string"
    || typeof value.createdAt !== "string"
    || typeof value.semanticFingerprint !== "string"
    || !SHA256_PATTERN.test(value.semanticFingerprint)
    || !isObject(value.rules)
    || !exactKeys(value.rules, ["fieldRegistry", "comparisonProfile", "referenceKeyset", "canonicalization"])
    || parseReviewRegistryIdentity(value.rules) === null
    || value.rules.canonicalization !== REFERENCE_RULES.canonicalization
    || !Array.isArray(value.files)
  ) throw new Error("invalid reference manifest");

  for (const file of value.files) {
    if (
      !isObject(file)
      || !exactKeys(file, ["path", "byteLength", "sha256", "private"])
      || typeof file.path !== "string"
      || typeof file.byteLength !== "number"
      || !Number.isSafeInteger(file.byteLength)
      || file.byteLength < 0
      || typeof file.sha256 !== "string"
      || !SHA256_PATTERN.test(file.sha256)
      || typeof file.private !== "boolean"
    ) throw new Error("invalid reference manifest file");
  }
}

function manifestPathIsSafe(path: string): boolean {
  return manifestArtifactPathIsSafe(path);
}

function assertPrivateMapping(
  evidence: ReferenceEvidenceV1,
  privateLocations: readonly PrivateSourceLocationV1[],
  requireCanonicalOrder = false
): void {
  if (privateLocations.length !== evidence.sources.length) throw new Error("private mapping cardinality mismatch");
  if (
    requireCanonicalOrder
    && privateLocations.some((location, index) => location.evidenceId !== evidence.sources[index]?.evidenceId)
  ) throw new Error("private mapping order mismatch");
  const locationsById = new Map<string, PrivateSourceLocationV1>();
  for (const location of privateLocations) {
    if (locationsById.has(location.evidenceId)) throw new Error("duplicate private mapping");
    locationsById.set(location.evidenceId, location);
  }
  for (const source of evidence.sources) {
    const location = locationsById.get(source.evidenceId);
    if (
      location === undefined
      || location.contentSha256 !== source.contentSha256
      || location.byteLength !== source.byteLength
      || location.mediaType !== source.mediaType
    ) throw new Error("public/private source mismatch");
  }
}

export class ReviewStore {
  readonly rootDirectory: string;
  readonly reviewsDirectory: string;
  readonly referenceSourceRoots: readonly string[];

  private readonly now: () => Date;
  private readonly beforeReferenceCommit?: ReviewStoreOptions["beforeReferenceCommit"];
  private readonly beforeReviewCommit?: ReviewStoreOptions["beforeReviewCommit"];
  private readonly caseStore?: ReviewStoreOptions["caseStore"];
  private readonly caseLocks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string, options?: ReviewStoreOptions) {
    if (typeof rootDirectory !== "string" || rootDirectory.length === 0 || rootDirectory.includes("\0")) {
      throw reviewError("REVIEW_ROOT_INVALID", "复核存储根目录无效", 422);
    }
    const canonicalRoot = canonicalExistingDirectory(
      resolve(rootDirectory),
      "REVIEW_ROOT_INVALID",
      "复核存储根目录无效"
    );
    if (
      !isObject(options)
      || !Array.isArray(options.referenceSourceRoots)
      || options.referenceSourceRoots.length === 0
    ) {
      throw reviewError("REFERENCE_SOURCE_ROOTS_INVALID", "批准来源根目录配置无效", 422);
    }
    assertReviewStoreOptions(options);
    const canonicalRoots: string[] = [];
    for (const root of options.referenceSourceRoots) {
      canonicalRoots.push(canonicalExistingDirectory(
        root,
        "REFERENCE_SOURCE_ROOTS_INVALID",
        "批准来源根目录配置无效"
      ));
    }
    this.rootDirectory = canonicalRoot;
    this.reviewsDirectory = safePath(this.rootDirectory, "reviews");
    this.referenceSourceRoots = Object.freeze([...new Set(canonicalRoots)]);
    this.now = options.now ?? (() => new Date());
    this.beforeReferenceCommit = options.beforeReferenceCommit;
    this.beforeReviewCommit = options.beforeReviewCommit;
    this.caseStore = options.caseStore;
  }

  async createReferenceSet(
    caseId: string,
    factory: (referenceSetId: string) => Promise<{
      evidence: ReferenceEvidenceV1;
      privateLocations: PrivateSourceLocationV1[];
    }> | {
      evidence: ReferenceEvidenceV1;
      privateLocations: PrivateSourceLocationV1[];
    }
  ): Promise<StoredReferenceSet> {
    assertCaseId(caseId);
    if (typeof factory !== "function") {
      throw reviewError("REFERENCE_FACTORY_INVALID", "参考集工厂无效", 422);
    }
    return normalizePublicReferenceStorage(() => this.withCaseLock(caseId, async () => {
      const referenceSetsDirectory = await this.ensureReferenceSetsDirectory(caseId);
      const directoryChain = await this.captureDirectoryChain(caseId, referenceSetsDirectory);
      const deadline = performance.now() + RESERVATION_DEADLINE_MS;
      while (true) {
        await this.assertDirectoryChain(directoryChain);
        const scan = await this.scanCommittedLineage(caseId, true);
        const referenceSetId = nextSequentialId("REF", [...scan.committed.keys()]);
        const blockingTransients = scan.transients.filter((entry) => (
          entry.id === referenceSetId
          || !scan.committed.has(entry.id)
        ));
        if (blockingTransients.some((entry) => entry.id !== referenceSetId)) {
          throw reviewError("REFERENCE_LINEAGE_CORRUPT", "参考集提交链包含无法识别的暂存条目", 409);
        }
        if (blockingTransients.length > 0) {
          if (performance.now() >= deadline) {
            throw reviewError("REFERENCE_SET_BUSY", "下一参考集编号正由其他写操作占用", 409);
          }
          await delay(RESERVATION_RETRY_MS);
          continue;
        }

        const reservationPath = safePath(referenceSetsDirectory, `.${referenceSetId}.reserve`);
        const acquired = await tryAcquireReservation(
          reservationPath,
          referenceSetsDirectory,
          directoryChain
        );
        if (acquired === undefined) {
          if (performance.now() >= deadline) {
            throw reviewError("REFERENCE_SET_BUSY", "下一参考集编号正由其他写操作占用", 409);
          }
          await delay(RESERVATION_RETRY_MS);
          continue;
        }

        try {
          return await this.commitReservedReferenceSet(
            caseId,
            referenceSetId,
            referenceSetsDirectory,
            directoryChain,
            acquired,
            factory
          );
        } catch (error) {
          if (error instanceof RetryReferenceAllocation) continue;
          throw error;
        } finally {
          await removeOwnedReservation(acquired, directoryChain);
        }
      }
    }));
  }

  async readReferenceSet(
    caseId: string,
    referenceSetId: string,
    options?: { includePrivate?: boolean }
  ): Promise<ReadReferenceSet> {
    assertCaseId(caseId);
    assertReferenceSetId(referenceSetId);
    assertReadOptions(options);
    return normalizePublicReferenceStorage(async () => {
      const scan = await this.scanCommittedLineage(caseId, false);
      const entry = scan.committed.get(referenceSetId);
      if (entry === undefined) {
        throw reviewError("REFERENCE_SET_NOT_FOUND", "参考集不存在", 404);
      }
      const includePrivate = options?.includePrivate === true;
      const manifest: ReferenceSetManifestV1 = structuredClone(entry.manifest);
      if (!includePrivate) manifest.files = manifest.files.filter((file) => !file.private);
      return {
        evidence: structuredClone(entry.evidence),
        manifest,
        ...(includePrivate ? { privateLocations: structuredClone(entry.privateLocations) } : {})
      };
    });
  }

  async readVerifiedReferenceSet(caseId: string, referenceSetId: string): Promise<ReferenceEvidenceV1> {
    return normalizePublicReferenceStorage(async () => {
      const read = await this.readReferenceSet(caseId, referenceSetId, { includePrivate: true });
      const privateLocations = read.privateLocations;
      if (privateLocations === undefined) {
        throw reviewError("REFERENCE_SET_CORRUPT", "参考集私密来源映射缺失", 409);
      }
      for (const location of privateLocations) {
        try {
          const status = await lstat(location.sourcePath);
          if (!status.isFile() || status.isSymbolicLink()) throw new Error("source type changed");
        } catch {
          throw reviewError("SOURCE_CHANGED", "参考来源内容与已授权记录不一致", 409);
        }
        let canonicalSource: string;
        try {
          canonicalSource = await realpath(location.sourcePath);
        } catch (error) {
          if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
            throw reviewError("SOURCE_CHANGED", "参考来源内容与已授权记录不一致", 409);
          }
          throw reviewError("REFERENCE_SOURCE_OUTSIDE_ROOTS", "参考来源不在批准目录内", 422);
        }
        if (!this.referenceSourceRoots.some((root) => isWithinRoot(canonicalSource, root))) {
          const wasLexicallyInside = this.referenceSourceRoots.some((root) => (
            isWithinRoot(resolve(location.sourcePath), root)
          ));
          throw wasLexicallyInside
            ? reviewError("SOURCE_CHANGED", "参考来源内容与已授权记录不一致", 409)
            : reviewError("REFERENCE_SOURCE_OUTSIDE_ROOTS", "参考来源不在批准目录内", 422);
        }
        try {
          await verifyReferenceSource({ ...location, sourcePath: canonicalSource });
        } catch (error) {
          if (error instanceof ReviewError && error.code === "SOURCE_CHANGED" && error.statusCode === 409) {
            throw error;
          }
          throw reviewError("SOURCE_CHANGED", "参考来源内容与已授权记录不一致", 409);
        }
      }
      return structuredClone(read.evidence);
    });
  }

  async listReferenceSets(caseId: string): Promise<StoredReferenceSet[]> {
    assertCaseId(caseId);
    return normalizePublicReferenceStorage(async () => {
      const scan = await this.scanCommittedLineage(caseId, false);
      return [...scan.committed.values()].map((entry) => structuredClone(entry.stored));
    });
  }

  async createReviewRevision(
    caseId: string,
    factory: ReviewRevisionFactory
  ): Promise<StoredReviewRevision> {
    assertCaseId(caseId);
    return this.withCaseLock(caseId, () => createReviewRevisionStorage({
      rootDirectory: this.rootDirectory,
      caseStore: this.caseStore,
      readVerifiedReferenceSet: (readCaseId, referenceSetId) => (
        this.readVerifiedReferenceSet(readCaseId, referenceSetId)
      ),
      ...(this.beforeReviewCommit === undefined
        ? {}
        : {
            beforeReviewCommit: (stored) => this.runStorageCallback(
              caseId,
              () => this.beforeReviewCommit!(stored)
            )
          })
    }, caseId, (reviewRevisionId, previousVerificationFingerprint) => (
      this.runStorageCallback(
        caseId,
        () => factory(reviewRevisionId, previousVerificationFingerprint)
      )
    )));
  }

  async readReviewRevision(
    caseId: string,
    reviewRevisionId: string
  ): Promise<ReadReviewRevision> {
    assertCaseId(caseId);
    return readReviewRevisionStorage({
      rootDirectory: this.rootDirectory,
      caseStore: this.caseStore,
      readVerifiedReferenceSet: (readCaseId, referenceSetId) => (
        this.readVerifiedReferenceSet(readCaseId, referenceSetId)
      )
    }, caseId, reviewRevisionId);
  }

  async listReviewRevisions(caseId: string): Promise<ReadReviewRevision[]> {
    assertCaseId(caseId);
    return listReviewRevisionsStorage({
      rootDirectory: this.rootDirectory,
      caseStore: this.caseStore,
      readVerifiedReferenceSet: (readCaseId, referenceSetId) => (
        this.readVerifiedReferenceSet(readCaseId, referenceSetId)
      )
    }, caseId);
  }

  private async commitReservedReferenceSet(
    caseId: string,
    referenceSetId: string,
    referenceSetsDirectory: string,
    directoryChain: readonly DirectoryIdentity[],
    reservation: OwnedReservationIdentity,
    factory: (referenceSetId: string) => Promise<{
      evidence: ReferenceEvidenceV1;
      privateLocations: PrivateSourceLocationV1[];
    }> | {
      evidence: ReferenceEvidenceV1;
      privateLocations: PrivateSourceLocationV1[];
    }
  ): Promise<StoredReferenceSet> {
    await this.assertDirectoryChain(directoryChain);
    const targetDirectory = safePath(referenceSetsDirectory, referenceSetId);
    if (await pathStatus(targetDirectory) !== undefined) throw new RetryReferenceAllocation();

    let created: Awaited<ReturnType<typeof factory>>;
    try {
      created = await this.runStorageCallback(caseId, () => factory(referenceSetId));
    } catch (error) {
      if (isReviewStoreReentrant(error)) throw reviewStoreReentrant();
      throw reviewError("REFERENCE_FACTORY_FAILED", "参考集工厂执行失败", 422);
    }
    await assertOwnedTransientIdentity(reservation, directoryChain);
    await this.assertDirectoryChain(directoryChain);
    if (!isObject(created) || !exactKeys(created, ["evidence", "privateLocations"])) {
      throw reviewError("REFERENCE_FACTORY_INVALID", "参考集工厂返回值无效", 422);
    }
    const parsedEvidence = ReferenceEvidenceV1Schema.safeParse(created.evidence);
    if (!parsedEvidence.success) {
      throw reviewError("REFERENCE_EVIDENCE_INVALID", "参考集公共证据无效", 422);
    }
    let privateLocations: PrivateSourceLocationV1[];
    try {
      privateLocations = parsePrivateLocations(created.privateLocations);
      assertPrivateMapping(parsedEvidence.data, privateLocations);
    } catch {
      throw reviewError("REFERENCE_PRIVATE_LOCATIONS_INVALID", "参考集私密来源映射无效", 422);
    }
    if (parsedEvidence.data.caseId !== caseId || parsedEvidence.data.referenceSetId !== referenceSetId) {
      throw reviewError("REFERENCE_IDENTITY_MISMATCH", "参考集案例或编号身份不一致", 422);
    }
    const deniedValues = privateLocations.flatMap((location) => [
      location.sourcePath,
      basename(location.sourcePath)
    ]);
    assertReferenceEvidencePublicPrivacy(parsedEvidence.data, deniedValues);
    for (const location of privateLocations) {
      try {
        const status = await lstat(location.sourcePath);
        if (!status.isFile() || status.isSymbolicLink()) throw new Error("source type invalid");
      } catch {
        throw reviewError("REFERENCE_PRIVATE_LOCATIONS_INVALID", "参考集私密来源映射无效", 422);
      }
      let canonicalSource: string;
      try {
        canonicalSource = await realpath(location.sourcePath);
      } catch {
        throw reviewError("REFERENCE_PRIVATE_LOCATIONS_INVALID", "参考集私密来源映射无效", 422);
      }
      if (!this.referenceSourceRoots.some((root) => isWithinRoot(canonicalSource, root))) {
        throw reviewError("REFERENCE_SOURCE_OUTSIDE_ROOTS", "参考来源不在批准目录内", 422);
      }
      await verifyReferenceSource({ ...location, sourcePath: canonicalSource });
      location.sourcePath = canonicalSource;
    }
    const canonicalDeniedValues = privateLocations.flatMap((location) => [
      location.sourcePath,
      basename(location.sourcePath)
    ]);
    assertReferenceEvidencePublicPrivacy(parsedEvidence.data, canonicalDeniedValues);
    const registryIdentity = referenceRegistryIdentityForFingerprint(parsedEvidence.data.semanticFingerprint);
    privateLocations.sort((left, right) => compareUnicodeCodePoints(left.evidenceId, right.evidenceId));

    await this.assertDirectoryChain(directoryChain);
    const staging = await createAtomicStagingDirectory(
      referenceSetsDirectory,
      referenceSetId
    );
    const stagingDirectory = staging.path;
    try {
      const privateDirectory = safePath(stagingDirectory, "private");
      await mkdir(privateDirectory, { mode: 0o700 });
      await writeCanonicalJson(safePath(stagingDirectory, "reference-evidence.json"), parsedEvidence.data);
      await writeCanonicalJson(safePath(privateDirectory, "source-locations.json"), privateLocations);
      await syncDirectory(privateDirectory);

      const files: ReferenceSetManifestFileV1[] = [];
      for (const artifactPath of EXPECTED_ARTIFACT_PATHS) {
        const bytes = await readStableRegularFile(
          safePath(stagingDirectory, ...artifactPath.split("/"))
        );
        files.push({
          path: artifactPath,
          byteLength: bytes.byteLength,
          sha256: `sha256:${sha256Bytes(bytes)}`,
          private: artifactPath.startsWith("private/")
        });
      }
      files.sort((left, right) => compareUnicodeCodePoints(left.path, right.path));
      const manifest: ReferenceSetManifestV1 = {
        schemaVersion: "1.0.0",
        kind: "reference_set",
        caseId,
        referenceSetId,
        createdAt: parsedEvidence.data.createdAt,
        semanticFingerprint: parsedEvidence.data.semanticFingerprint,
        rules: {
          fieldRegistry: registryIdentity.fieldRegistry,
          comparisonProfile: registryIdentity.comparisonProfile,
          referenceKeyset: registryIdentity.referenceKeyset,
          canonicalization: REFERENCE_RULES.canonicalization
        },
        files
      };
      await writeCanonicalJson(safePath(stagingDirectory, "manifest.json"), manifest);
      await this.verifyReferenceDirectory(stagingDirectory, caseId, referenceSetId);
      await syncDirectory(stagingDirectory);

      const stored: StoredReferenceSet = {
        caseId,
        referenceSetId,
        directory: targetDirectory,
        semanticFingerprint: parsedEvidence.data.semanticFingerprint,
        createdAt: parsedEvidence.data.createdAt
      };
      const hookView = Object.freeze(structuredClone(stored));
      if (this.beforeReferenceCommit !== undefined) {
        try {
          await this.runStorageCallback(caseId, () => this.beforeReferenceCommit!(hookView));
        } catch (error) {
          if (isReviewStoreReentrant(error)) throw reviewStoreReentrant();
          throw reviewError("REFERENCE_COMMIT_HOOK_FAILED", "参考集提交钩子执行失败", 409);
        }
      }
      await assertOwnedTransientIdentity(reservation, directoryChain);
      await assertOwnedTransientIdentity(staging, directoryChain);
      await this.assertDirectoryChain(directoryChain);
      await this.verifyReferenceDirectory(stagingDirectory, caseId, referenceSetId);
      await this.assertDirectoryChain(directoryChain);
      if (await pathStatus(targetDirectory) !== undefined) throw new RetryReferenceAllocation();
      try {
        await commitAtomicStagingDirectory(
          staging,
          targetDirectory,
          directoryChain
        );
      } catch (error) {
        if (isNodeError(error) && ["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) {
          throw new RetryReferenceAllocation();
        }
        throw error;
      }
      return structuredClone(stored);
    } catch (error) {
      await removeOwnedStagingDirectory(staging, directoryChain);
      throw error;
    }
  }

  private async ensureReferenceSetsDirectory(caseId: string): Promise<string> {
    assertCaseId(caseId);
    let current = this.rootDirectory;
    for (const segment of ["reviews", caseId, "reference-sets"]) {
      const next = safePath(current, segment);
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
        throw reviewError("UNSAFE_REVIEW_PATH", "复核存储目录不是安全的普通目录", 422);
      }
      current = next;
    }
    return current;
  }

  private async captureDirectoryChain(
    caseId: string,
    referenceSetsDirectory: string
  ): Promise<DirectoryIdentity[]> {
    const paths = [
      this.rootDirectory,
      safePath(this.rootDirectory, "reviews"),
      safePath(this.rootDirectory, "reviews", caseId),
      referenceSetsDirectory
    ];
    return captureDirectoryIdentities(paths);
  }

  private async assertDirectoryChain(chain: readonly DirectoryIdentity[]): Promise<void> {
    await assertDirectoryIdentities(chain);
  }

  private async existingReferenceSetsDirectory(caseId: string): Promise<string | undefined> {
    assertCaseId(caseId);
    let current = this.rootDirectory;
    for (const segment of ["reviews", caseId, "reference-sets"]) {
      const next = safePath(current, segment);
      const status = await pathStatus(next);
      if (status === undefined) return undefined;
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw reviewError("UNSAFE_REVIEW_PATH", "复核存储目录不是安全的普通目录", 422);
      }
      current = next;
    }
    return current;
  }

  private async scanCommittedLineage(caseId: string, allowTransients: boolean): Promise<LineageScan> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      try {
        return await this.scanCommittedLineageSnapshot(caseId, allowTransients);
      } catch (error) {
        if (!(error instanceof RetryLineageSnapshot)) throw error;
      }
    }
    throw reviewError("REFERENCE_SET_BUSY", "参考集目录在读取期间持续变化", 409);
  }

  private async scanCommittedLineageSnapshot(caseId: string, allowTransients: boolean): Promise<LineageScan> {
    const referenceSetsDirectory = await this.existingReferenceSetsDirectory(caseId);
    if (referenceSetsDirectory === undefined) return { committed: new Map(), transients: [] };
    let names: string[];
    try {
      names = await readdir(referenceSetsDirectory);
    } catch {
      throw reviewError("REFERENCE_LINEAGE_CORRUPT", "无法安全读取参考集提交链", 409);
    }
    const ids: string[] = [];
    const transients: TransientEntry[] = [];
    for (const name of names) {
      const idMatch = REFERENCE_SET_ID_PATTERN.exec(name);
      if (idMatch !== null && Number(idMatch[1]) >= 1) {
        ids.push(name);
        continue;
      }
      const reservationMatch = RESERVATION_PATTERN.exec(name);
      const stagingMatch = STAGING_PATTERN.exec(name);
      if (reservationMatch !== null || stagingMatch !== null) {
        const id = (reservationMatch ?? stagingMatch)![1];
        let status;
        try {
          status = await lstat(safePath(referenceSetsDirectory, name));
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") throw new RetryLineageSnapshot();
          throw reviewError("REFERENCE_LINEAGE_CORRUPT", "参考集暂存条目无法安全读取", 409);
        }
        const regular = reservationMatch !== null
          ? status.isFile() && !status.isSymbolicLink()
          : status.isDirectory() && !status.isSymbolicLink();
        if (!regular) {
          throw reviewError("REFERENCE_LINEAGE_CORRUPT", "参考集提交链包含不安全的暂存条目", 409);
        }
        transients.push({ id, kind: reservationMatch !== null ? "reservation" : "staging", name });
        continue;
      }
      throw reviewError("REFERENCE_LINEAGE_CORRUPT", "参考集提交链包含无法识别的条目", 409);
    }

    ids.sort((left, right) => referenceOrdinal(left) - referenceOrdinal(right));
    const committed = new Map<string, ValidatedReferenceSet>();
    for (const id of ids) {
      committed.set(id, await this.verifyReferenceDirectory(
        safePath(referenceSetsDirectory, id),
        caseId,
        id
      ));
    }
    const reservationIds = new Set(
      transients.filter((entry) => entry.kind === "reservation").map((entry) => entry.id)
    );
    const stagingCounts = new Map<string, number>();
    for (const entry of transients) {
      if (entry.kind !== "staging") continue;
      stagingCounts.set(entry.id, (stagingCounts.get(entry.id) ?? 0) + 1);
      if (committed.has(entry.id) || !reservationIds.has(entry.id) || stagingCounts.get(entry.id)! > 1) {
        throw reviewError("REFERENCE_LINEAGE_CORRUPT", "参考集提交链包含未完成的暂存目录", 409);
      }
    }
    const activeTransients = transients.filter((entry) => !committed.has(entry.id));
    if (!allowTransients && activeTransients.length > 0) {
      throw reviewError("REFERENCE_SET_BUSY", "参考集目录存在尚未完成的写操作", 409);
    }
    return { committed, transients };
  }

  private async verifyReferenceDirectory(
    directory: string,
    expectedCaseId: string,
    expectedReferenceSetId: string
  ): Promise<ValidatedReferenceSet> {
    try {
      const directoryStatus = await lstat(directory);
      if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
        throw new Error("reference set is not a regular directory");
      }
      const manifestBytes = await readStableRegularFile(safePath(directory, "manifest.json"));
      const manifestValue = parseCanonicalJson(manifestBytes);
      assertManifest(manifestValue);
      const manifest = structuredClone(manifestValue);
      if (
        manifest.caseId !== expectedCaseId
        || manifest.referenceSetId !== expectedReferenceSetId
      ) throw new Error("manifest identity mismatch");

      const manifestPaths = manifest.files.map((file) => file.path);
      if (
        manifestPaths.some((path) => !manifestPathIsSafe(path))
        || new Set(manifestPaths).size !== manifestPaths.length
        || canonicalJson(manifestPaths) !== canonicalJson(EXPECTED_ARTIFACT_PATHS)
      ) throw new Error("manifest paths invalid");
      for (const file of manifest.files) {
        if (file.private !== file.path.startsWith("private/")) {
          throw new Error("manifest privacy flag mismatch");
        }
      }

      const { files: actualFiles, directories: actualDirectories } = await collectArtifactTree(directory);
      if (
        canonicalJson(actualFiles) !== canonicalJson(EXPECTED_ARTIFACT_PATHS)
        || canonicalJson(actualDirectories) !== canonicalJson(EXPECTED_DIRECTORY_PATHS)
      ) throw new Error("artifact tree mismatch");

      const artifactBytes = new Map<string, Buffer>();
      for (const file of manifest.files) {
        const bytes = await readStableRegularFile(safePath(directory, ...file.path.split("/")));
        if (
          bytes.byteLength !== file.byteLength
          || `sha256:${sha256Bytes(bytes)}` !== file.sha256
        ) throw new Error("artifact hash mismatch");
        artifactBytes.set(file.path, bytes);
      }
      const evidenceValue = parseCanonicalJson(artifactBytes.get("reference-evidence.json")!);
      const evidenceParse = ReferenceEvidenceV1Schema.safeParse(evidenceValue);
      if (!evidenceParse.success) throw new Error("invalid reference evidence");
      const privateLocations = parsePrivateLocations(
        parseCanonicalJson(artifactBytes.get("private/source-locations.json")!)
      );
      assertPrivateMapping(evidenceParse.data, privateLocations, true);
      const deniedValues = privateLocations.flatMap((location) => [
        location.sourcePath,
        basename(location.sourcePath)
      ]);
      assertReferenceEvidencePublicPrivacy(evidenceParse.data, deniedValues);
      if (
        evidenceParse.data.caseId !== expectedCaseId
        || evidenceParse.data.referenceSetId !== expectedReferenceSetId
        || evidenceParse.data.createdAt !== manifest.createdAt
        || evidenceParse.data.semanticFingerprint !== manifest.semanticFingerprint
      ) throw new Error("reference semantic identity mismatch");
      const registryIdentity = parseReviewRegistryIdentity(manifest.rules);
      if (registryIdentity === null) throw new Error("reference registry identity mismatch");
      bindReferenceRegistryIdentity(evidenceParse.data.semanticFingerprint, registryIdentity);

      return {
        stored: {
          caseId: expectedCaseId,
          referenceSetId: expectedReferenceSetId,
          directory,
          semanticFingerprint: evidenceParse.data.semanticFingerprint,
          createdAt: evidenceParse.data.createdAt
        },
        evidence: evidenceParse.data,
        privateLocations,
        manifest
      };
    } catch (error) {
      if (error instanceof ReviewError && error.code === "REFERENCE_SET_CORRUPT") throw error;
      throw reviewError("REFERENCE_SET_CORRUPT", "已提交参考集未通过完整性校验", 409);
    }
  }

  private caseLockKey(caseId: string): string {
    return JSON.stringify([this.rootDirectory, caseId]);
  }

  private async runStorageCallback<T>(caseId: string, callback: () => Promise<T> | T): Promise<T> {
    const frame: ReviewStoreCallbackScope = {
      key: this.caseLockKey(caseId),
      active: true
    };
    const inherited = reviewStoreCallbackScopes.getStore() ?? [];
    try {
      return await reviewStoreCallbackScopes.run([...inherited, frame], callback);
    } finally {
      frame.active = false;
    }
  }

  private async withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    assertCaseId(caseId);
    const key = this.caseLockKey(caseId);
    if (reviewStoreCallbackScopes.getStore()?.some((scope) => (
      scope.active && scope.key === key
    )) === true) throw reviewStoreReentrant();
    const previous = this.caseLocks.get(caseId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    this.caseLocks.set(caseId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.caseLocks.get(caseId) === current) this.caseLocks.delete(caseId);
    }
  }
}
