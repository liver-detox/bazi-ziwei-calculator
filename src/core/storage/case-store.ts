import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  AUDIT_CONTRACT_VERSION_V4,
  AuditReportV1Schema,
  AuditReportV2Schema,
  CoverageProofV1Schema,
  buildDetailedAuditReport,
  deriveVersionEvidence,
  parseAuditReportForContract,
  type AuditReportV1,
  type AuditReportV2
} from "../audit/index.js";
import {
  parseBoundBaziDetail,
  type BaziDetailV1,
  type DualTrackChartSetV1
} from "../charts/index.js";
import {
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema,
  type PublicBirthRecordV2,
  type TimeEvidenceV2
} from "../../shared/provided-time-contracts.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import {
  renderAuditMarkdown,
  renderLegacyAuditMarkdown,
  renderLegacyReportReferenceMarkdown,
  renderReportReferenceMarkdown
} from "../workbench/artifacts.js";
import {
  AUDIT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION_V2,
  assessStoredRevisionIdentity,
  type ApprovedDependencyIdentity,
  type ApprovedRuleIdentity,
  type RevisionGenerationV1
} from "../workbench/revision-version-identity.js";
import { canonicalJson, sha256File, writeCanonicalJson } from "./canonical.js";
import { archiveEvidenceDirectory } from "./evidence-archive.js";
import {
  computeRevisionContentFingerprint,
  computeRevisionContentFingerprintV4
} from "./revision-content-fingerprint.js";

const CASE_ID = /^CS-\d{4}-\d{3}$/u;
const REVISION_ID = /^R\d{3}$/u;
const WORKFLOW_STATUSES = ["draft", "review", "verified", "void"] as const;

const PrecisionCoverageV2StorageSchema = z.object({
  mode: z.enum(["point", "interval", "branch"]),
  complete: z.boolean(),
  candidateIds: z.array(z.string().min(1)),
  note: z.string().min(1).nullable(),
  proof: z.unknown().nullable()
}).strict();
const PrecisionCoverageV4StorageSchema = PrecisionCoverageV2StorageSchema.extend({
  proof: CoverageProofV1Schema.nullable()
}).strict();
const CalculationContextV2StorageSchema = z.object({
  schemaVersion: z.literal("2.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  timeInputBasis: z.enum(["apparent_solar_provided", "civil_clock_provided"]),
  provenanceFlags: z.array(z.enum([
    "provided_time_apparent_solar",
    "provided_time_civil_clock",
    "provided_time_source_note_present"
  ])),
  precisionCoverage: PrecisionCoverageV2StorageSchema
}).strict();
const CalculationContextV4StorageSchema = CalculationContextV2StorageSchema.extend({
  precisionCoverage: PrecisionCoverageV4StorageSchema
}).strict();
const CalculationContextV2FallbackStorageSchema = CalculationContextV2StorageSchema.extend({
  baziDetailGenerationStatus: z.literal("retryable_failure")
}).strict();
const StoredPrivateContextSchema = z.object({
  privateName: z.string().trim().min(1).optional(),
  birthplaceNote: z.string().trim().min(1).optional(),
  providedTimeSourceNote: z.string().trim().min(1).optional()
}).strict();

export type WorkflowStatus = typeof WORKFLOW_STATUSES[number];

export interface LegacySourceRecord {
  sourcePath: string;
  fileName: string;
  byteLength: number;
  modifiedAt: string;
  sha256: string;
}

interface RevisionArtifactsBase {
  input: Record<string, unknown>;
  timeEvidence: unknown;
  charts: unknown;
  audit: unknown;
  auditMarkdown: string;
  reportReferenceMarkdown: string;
  workflowStatus: WorkflowStatus;
  auditContractVersion?: unknown;
  rules: Record<string, string>;
  dependencies: Record<string, string>;
  sourceImport?: LegacySourceRecord;
  calculationContext?: Record<string, unknown>;
  privateContext?: {
    privateName?: string;
    birthplaceNote?: string;
    providedTimeSourceNote?: string;
  };
}

export interface RevisionArtifactsV1ToV3 extends RevisionArtifactsBase {
  auditContractVersion?: unknown;
  baziDetail?: never;
}

export interface RevisionArtifactsV4 extends RevisionArtifactsBase {
  auditContractVersion: typeof AUDIT_CONTRACT_VERSION_V4;
  input: PublicBirthRecordV2;
  timeEvidence: TimeEvidenceV2;
  charts: DualTrackChartSetV1;
  baziDetail: BaziDetailV1;
  audit: AuditReportV2;
  sourceImport?: never;
}

export type RevisionArtifacts = RevisionArtifactsV1ToV3 | RevisionArtifactsV4;

export type RevisionArtifactsFactory = (
  revisionId: string
) => RevisionArtifacts | Promise<RevisionArtifacts>;

export interface StoredRevision {
  caseId: string;
  revisionId: string;
  workflowStatus: WorkflowStatus;
  directory: string;
  contentFingerprint: string;
}

export interface CaseStoreOptions {
  now?: () => Date;
  beforeCommit?: (revision: StoredRevision) => void | Promise<void>;
}

export interface RevisionManifestFile {
  path: string;
  byteLength: number;
  sha256: string;
  private: boolean;
}

export interface RevisionManifest {
  schemaVersion: "1.0.0";
  auditContractVersion?: unknown;
  caseId: string;
  revisionId: string;
  workflowStatus: WorkflowStatus;
  createdAt: string;
  rules: Record<string, string>;
  dependencies: Record<string, string>;
  contentFingerprint: string;
  files: RevisionManifestFile[];
}

export class CaseStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CaseStoreError";
    this.code = code;
  }
}

export interface CreateRevisionOptions {
  revisionId?: string;
}

export interface CreateRevisionFromFactoryOptions {
  expectedLineage?: "any" | "empty";
}

interface ReadRevisionOptions {
  includePrivate?: boolean;
}

export interface ExportRevisionOptions {
  includePrivate?: boolean;
}

interface JsonObject {
  [key: string]: unknown;
}

export type AuditEvidenceStatus = "modern_valid" | "legacy_unvalidated";

export interface RevisionDownloadArchive {
  filename: string;
  contentType: "application/gzip";
  bytes: Buffer;
  redacted: boolean;
  auditEvidenceStatus: AuditEvidenceStatus;
}

interface AuditEvidenceView {
  status: AuditEvidenceStatus;
  audit: Record<string, unknown>;
  legacyAudit?: Record<string, unknown>;
  auditMarkdown: string;
  reportReferenceMarkdown: string;
  allowedAnalysisModes: string[];
  revisionGeneration: RevisionGenerationV1;
  approvedIdentity?: { rules: ApprovedRuleIdentity; dependencies: ApprovedDependencyIdentity };
}

interface ValidatedLineageEntry {
  manifest: RevisionManifest;
  input: Record<string, unknown>;
  rawAudit: Record<string, unknown>;
  auditEvidence: AuditEvidenceView;
}

interface VerifiedExportSource {
  revisionDirectory: string;
  sourceManifest: RevisionManifest;
  auditEvidence: AuditEvidenceView;
}

function assertCaseId(caseId: string): void {
  if (!CASE_ID.test(caseId)) {
    throw new CaseStoreError("INVALID_CASE_ID", "案例编号必须符合 CS-YYYY-NNN");
  }
}

function assertRevisionId(revisionId: string): void {
  if (!REVISION_ID.test(revisionId)) {
    throw new CaseStoreError("INVALID_REVISION_ID", "修订号必须符合 RNNN");
  }
}

function assertWorkflowStatus(status: string): asserts status is WorkflowStatus {
  if (!(WORKFLOW_STATUSES as readonly string[]).includes(status)) {
    throw new CaseStoreError("INVALID_WORKFLOW_STATUS", "流程状态无效");
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidAuditReport(message: string): never {
  throw new CaseStoreError("AUDIT_REPORT_INVALID", message);
}

function assertInputContractMatchesAudit(
  input: Record<string, unknown>,
  report: AuditReportV1 | AuditReportV2,
  auditContractVersion: unknown
): void {
  if (auditContractVersion === AUDIT_CONTRACT_VERSION || auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
    const provided = PublicBirthRecordV2Schema.safeParse(input);
    if (!provided.success || report.timeInputBoundary?.basis !== provided.data.providedTime.basis) {
      invalidAuditReport("v3 审计边界必须与公开时间输入口径一致");
    }
    return;
  }
  if (input.schemaVersion !== "1.0.0") {
    invalidAuditReport("历史审计契约只能绑定 V1 输入");
  }
}

function assertApprovedNewRevisionArtifacts(
  caseId: string,
  revisionId: string,
  artifacts: RevisionArtifacts
): void {
  const hasMarker = Object.prototype.hasOwnProperty.call(artifacts, "auditContractVersion");
  if (hasMarker && typeof artifacts.auditContractVersion !== "string") {
    invalidAuditReport("新修订的审计契约标记类型无效");
  }
  if (
    artifacts.auditContractVersion !== AUDIT_CONTRACT_VERSION
    && artifacts.auditContractVersion !== AUDIT_CONTRACT_VERSION_V2
    && artifacts.auditContractVersion !== AUDIT_CONTRACT_VERSION_V4
  ) {
    invalidAuditReport("新修订必须使用获批的 v2、v3 或 v4 审计契约");
  }
  const assessment = assessStoredRevisionIdentity({
    ...(hasMarker
      ? { auditContractVersion: artifacts.auditContractVersion as string }
      : {}),
    manifestRules: artifacts.rules,
    manifestDependencies: artifacts.dependencies,
    report: artifacts.audit
  });
  if (assessment.generation !== "modern" || assessment.trust !== "approved") {
    invalidAuditReport("新修订必须携带完整且获批的版本身份链");
  }
  const report = artifacts.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
    ? AuditReportV2Schema.safeParse(artifacts.audit)
    : AuditReportV1Schema.safeParse(artifacts.audit);
  if (
    !report.success
    || report.data.caseId !== caseId
    || report.data.revisionId !== revisionId
    || report.data.auditReportId !== `AUD-${caseId}-${revisionId}`
    || report.data.workflowStatus !== artifacts.workflowStatus
    || artifacts.input.caseId !== caseId
    || typeof artifacts.input.alias !== "string"
  ) {
    invalidAuditReport("新修订的审计报告、输入与修订身份不一致");
  }
  if (artifacts.auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
    if (artifacts.sourceImport !== undefined || !("baziDetail" in artifacts)) {
      invalidAuditReport("v4 修订必须携带公开详盘且不得携带历史来源");
    }
    const publicInput = PublicBirthRecordV2Schema.parse(artifacts.input);
    const timeEvidence = TimeEvidenceV2Schema.parse(artifacts.timeEvidence);
    parseBoundBaziDetail({
      publicBirthRecord: publicInput,
      timeEvidence,
      baseChartSet: artifacts.charts as DualTrackChartSetV1,
      detail: artifacts.baziDetail
    });
    CalculationContextV4StorageSchema.parse(artifacts.calculationContext);
  } else if ("baziDetail" in artifacts && artifacts.baziDetail !== undefined) {
    invalidAuditReport("v1-v3 修订不得携带详盘文件");
  }
  assertInputContractMatchesAudit(artifacts.input, report.data, artifacts.auditContractVersion);
}

function nextRevisionIdFromCommittedManifests(manifests: ReadonlyMap<string, RevisionManifest>): string {
  const next = manifests.size + 1;
  if (next > 999) {
    throw new CaseStoreError("REVISION_LIMIT", "修订数量已超过 R999");
  }
  return `R${String(next).padStart(3, "0")}`;
}

function assertMarkerSelectedFixedFiles(
  auditContractVersion: unknown,
  paths: readonly string[]
): void {
  const fileSet = new Set(paths);
  const required = [
    "input.json",
    "time-evidence.json",
    "charts.json",
    "audit.json",
    "audit.md",
    "report-reference.md"
  ];
  if (required.some((path) => !fileSet.has(path)) || fileSet.size !== paths.length) {
    throw new Error("required fixed artifact set is incomplete or duplicated");
  }
  const allowed = new Set([
    ...required,
    "calculation-context.json",
    "source-import-reference.json",
    "private/identity.json",
    "private/context.json",
    "private/source-import.json",
    ...(auditContractVersion === AUDIT_CONTRACT_VERSION_V4 ? ["bazi-detail.json"] : [])
  ]);
  if (paths.some((path) => !allowed.has(path))) {
    throw new Error("artifact set contains an unexpected file");
  }
  if (auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
    if (
      !fileSet.has("bazi-detail.json")
      || !fileSet.has("calculation-context.json")
      || fileSet.has("source-import-reference.json")
      || fileSet.has("private/identity.json")
      || fileSet.has("private/source-import.json")
    ) {
      throw new Error("v4 fixed artifact set is invalid");
    }
  } else if (paths.some((path) => path === "bazi-detail.json" || path.endsWith("/bazi-detail.json"))) {
    throw new Error("v1-v3 fixed artifact set cannot contain bazi detail");
  }
  if (fileSet.has("source-import-reference.json") !== fileSet.has("private/source-import.json")) {
    throw new Error("source import public/private artifact pair is incomplete");
  }
}

function auditEvidenceView(
  input: Record<string, unknown>,
  rawAudit: Record<string, unknown>,
  manifest: RevisionManifest
): AuditEvidenceView {
  const hasMarker = Object.prototype.hasOwnProperty.call(manifest, "auditContractVersion");
  if (hasMarker && typeof manifest.auditContractVersion !== "string") {
    invalidAuditReport("版本身份链中的审计契约标记类型无效");
  }
  const identity = assessStoredRevisionIdentity({
    ...(hasMarker ? { auditContractVersion: manifest.auditContractVersion as string } : {}),
    manifestRules: manifest.rules,
    manifestDependencies: manifest.dependencies,
    report: rawAudit
  });
  if (identity.trust === "invalid") invalidAuditReport("版本身份链不一致");
  if (identity.generation !== "legacy") {
    const parsed = manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
      ? AuditReportV2Schema.safeParse(rawAudit)
      : AuditReportV1Schema.safeParse(rawAudit);
    if (!parsed.success) {
      invalidAuditReport("当前格式审计报告不满足标记选定的交叉不变量");
    }
    const report = parsed.data;
    if (
      report.caseId !== manifest.caseId
      || report.revisionId !== manifest.revisionId
      || report.auditReportId !== `AUD-${manifest.caseId}-${manifest.revisionId}`
      || report.workflowStatus !== manifest.workflowStatus
      || manifest.rules.audit !== report.rulesetVersion
      || input.caseId !== manifest.caseId
      || typeof input.alias !== "string"
    ) {
      invalidAuditReport("当前格式审计报告与案例清单或输入身份不一致");
    }
    assertInputContractMatchesAudit(input, report, manifest.auditContractVersion);
    const record = { caseId: manifest.caseId, alias: input.alias };
    return {
      status: "modern_valid",
      audit: report as (AuditReportV1 | AuditReportV2) & Record<string, unknown>,
      auditMarkdown: renderAuditMarkdown(
        record,
        report,
        manifest.auditContractVersion as Parameters<typeof renderAuditMarkdown>[2]
      ),
      reportReferenceMarkdown: renderReportReferenceMarkdown(
        record,
        report,
        manifest.auditContractVersion as Parameters<typeof renderReportReferenceMarkdown>[2]
      ),
      allowedAnalysisModes: [...report.allowedAnalysisModes],
      revisionGeneration: identity.generation,
      approvedIdentity: { rules: identity.expectedRules, dependencies: identity.expectedDependencies }
    };
  }

  return buildLegacyAuditEvidenceView(input, rawAudit, manifest);
}

function buildLegacyAuditEvidenceView(
  input: Record<string, unknown>,
  rawAudit: Record<string, unknown>,
  manifest: RevisionManifest
): AuditEvidenceView {
  const allowedAnalysisModes = manifest.workflowStatus === "void" ? [] : ["data_diagnosis"];
  return {
    status: "legacy_unvalidated",
    audit: {
      reportFormat: "legacy_unvalidated",
      caseId: manifest.caseId,
      revisionId: manifest.revisionId,
      workflowStatus: manifest.workflowStatus,
      auditLevel: "D",
      engineVersions: null,
      allowedAnalysisModes
    },
    legacyAudit: rawAudit,
    auditMarkdown: renderLegacyAuditMarkdown(input, rawAudit),
    reportReferenceMarkdown: renderLegacyReportReferenceMarkdown(input, rawAudit),
    allowedAnalysisModes,
    revisionGeneration: "legacy"
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function splitPrivateInput(input: Record<string, unknown>): {
  publicInput: Record<string, unknown>;
  privateIdentity?: { privateName: string };
} {
  const { privateName, ...publicInput } = input;
  if (privateName === undefined) {
    return { publicInput };
  }
  if (typeof privateName !== "string" || privateName.trim().length === 0) {
    throw new CaseStoreError("INVALID_PRIVATE_NAME", "私密姓名必须是非空字符串");
  }
  return { publicInput, privateIdentity: { privateName } };
}

function validatedPrivateContext(
  value: RevisionArtifacts["privateContext"]
): RevisionArtifacts["privateContext"] {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  const allowedKeys = new Set(["privateName", "birthplaceNote", "providedTimeSourceNote"]);
  if (
    entries.length === 0
    || entries.some(([key]) => !allowedKeys.has(key))
    || entries.some(([, item]) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new CaseStoreError("INVALID_PRIVATE_CONTEXT", "私密上下文必须只包含非空文本");
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, (item as string).trim()]));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeDurableText(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class CaseStore {
  readonly rootDirectory: string;
  readonly casesDirectory: string;
  readonly exportsDirectory: string;

  private readonly now: () => Date;
  private readonly beforeCommit?: CaseStoreOptions["beforeCommit"];
  private readonly caseLocks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string, options: CaseStoreOptions = {}) {
    this.rootDirectory = resolve(rootDirectory);
    this.casesDirectory = join(this.rootDirectory, "cases");
    this.exportsDirectory = join(this.rootDirectory, "exports");
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
  }

  async createRevision(
    caseId: string,
    artifacts: RevisionArtifacts,
    options: CreateRevisionOptions = {}
  ): Promise<StoredRevision> {
    return this.withCaseLock(caseId, async () => {
      const revisionsDirectory = this.revisionsDirectory(caseId);
      const manifests = await this.verifyCommittedLineage(caseId);
      await this.validateIdentityLineage(caseId, manifests);
      const revisionId = options.revisionId ?? nextRevisionIdFromCommittedManifests(manifests);
      assertRevisionId(revisionId);
      assertWorkflowStatus(artifacts.workflowStatus);
      assertApprovedNewRevisionArtifacts(caseId, revisionId, artifacts);
      await mkdir(revisionsDirectory, { recursive: true, mode: 0o700 });
      const reservation = await this.reserveRevisionId(revisionsDirectory, revisionId);
      try {
        return await this.createRevisionUnlocked(caseId, artifacts, revisionId, manifests);
      } finally {
        await rm(reservation.path, { force: true });
      }
    });
  }

  async createRevisionFromFactory(
    caseId: string,
    factory: RevisionArtifactsFactory,
    options: CreateRevisionFromFactoryOptions = {}
  ): Promise<StoredRevision> {
    return this.withCaseLock(caseId, async () => {
      assertCaseId(caseId);
      const revisionsDirectory = this.revisionsDirectory(caseId);
      if ((options.expectedLineage ?? "any") === "empty") {
        const manifests = await this.verifyCommittedLineage(caseId);
        await this.validateIdentityLineage(caseId, manifests);
        await mkdir(revisionsDirectory, { recursive: true, mode: 0o700 });
        const entries = await readdir(revisionsDirectory);
        if (
          manifests.size !== 0
          || entries.some((entry) => /^\.R\d{3}(?:\.reserve|\.tmp-)/u.test(entry))
        ) {
          throw new CaseStoreError(
            "EXPECTED_EMPTY_LINEAGE_CHANGED",
            "预期的空修订链已发生变化"
          );
        }
        const revisionId = "R001";
        let reservation: { revisionId: string; path: string };
        try {
          reservation = await this.reserveRevisionId(revisionsDirectory, revisionId);
        } catch (error) {
          if (error instanceof CaseStoreError && error.code === "REVISION_EXISTS") {
            throw new CaseStoreError(
              "EXPECTED_EMPTY_LINEAGE_CHANGED",
              "预期的空修订链已发生变化",
              { cause: error }
            );
          }
          throw error;
        }
        try {
          const artifacts = await factory(revisionId);
          assertWorkflowStatus(artifacts.workflowStatus);
          assertApprovedNewRevisionArtifacts(caseId, revisionId, artifacts);
          return await this.createRevisionUnlocked(caseId, artifacts, revisionId, manifests);
        } finally {
          await rm(reservation.path, { force: true });
        }
      }
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const manifests = await this.verifyCommittedLineage(caseId);
        await this.validateIdentityLineage(caseId, manifests);
        const revisionId = nextRevisionIdFromCommittedManifests(manifests);
        const artifacts = await factory(revisionId);
        assertWorkflowStatus(artifacts.workflowStatus);
        assertApprovedNewRevisionArtifacts(caseId, revisionId, artifacts);
        await mkdir(revisionsDirectory, { recursive: true, mode: 0o700 });
        try {
          const reservation = await this.reserveRevisionId(revisionsDirectory, revisionId);
          try {
            return await this.createRevisionUnlocked(caseId, artifacts, revisionId, manifests);
          } finally {
            await rm(reservation.path, { force: true });
          }
        } catch (error) {
          if (!(error instanceof CaseStoreError) || error.code !== "REVISION_EXISTS") throw error;
          const refreshed = await this.verifyCommittedLineage(caseId);
          if (refreshed.size === manifests.size) throw error;
        }
      }
      throw new CaseStoreError("REVISION_RESERVATION_FAILED", "无法分配新的修订号");
    });
  }

  private async createRevisionUnlocked(
    caseId: string,
    artifacts: RevisionArtifacts,
    revisionId: string,
    verifiedEarlierManifests: ReadonlyMap<string, RevisionManifest>
  ): Promise<StoredRevision> {
    assertCaseId(caseId);
    assertWorkflowStatus(artifacts.workflowStatus);
    assertRevisionId(revisionId);
    assertApprovedNewRevisionArtifacts(caseId, revisionId, artifacts);
    const revisionsDirectory = this.revisionsDirectory(caseId);
    await mkdir(revisionsDirectory, { recursive: true, mode: 0o700 });

    const targetDirectory = this.safePath(revisionsDirectory, revisionId);
    if (await pathExists(targetDirectory)) {
      throw new CaseStoreError("REVISION_EXISTS", `${caseId}/${revisionId} 已存在，不能覆盖`);
    }

    const stagingDirectory = this.safePath(revisionsDirectory, `.${revisionId}.tmp-${randomUUID()}`);
    await mkdir(stagingDirectory, { mode: 0o700 });

    try {
      const { publicInput, privateIdentity } = splitPrivateInput(artifacts.input);
      await writeCanonicalJson(join(stagingDirectory, "input.json"), publicInput);
      await writeCanonicalJson(join(stagingDirectory, "time-evidence.json"), artifacts.timeEvidence);
      await writeCanonicalJson(join(stagingDirectory, "charts.json"), artifacts.charts);
      if (artifacts.auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
        await writeCanonicalJson(join(stagingDirectory, "bazi-detail.json"), artifacts.baziDetail);
      }
      await writeCanonicalJson(join(stagingDirectory, "audit.json"), artifacts.audit);
      await writeDurableText(join(stagingDirectory, "audit.md"), artifacts.auditMarkdown);
      await writeDurableText(join(stagingDirectory, "report-reference.md"), artifacts.reportReferenceMarkdown);

      if (privateIdentity !== undefined) {
        const privateDirectory = join(stagingDirectory, "private");
        await mkdir(privateDirectory, { mode: 0o700 });
        await writeCanonicalJson(join(privateDirectory, "identity.json"), privateIdentity);
      }
      const privateContext = validatedPrivateContext(artifacts.privateContext);
      if (privateContext !== undefined) {
        const privateDirectory = join(stagingDirectory, "private");
        await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
        await writeCanonicalJson(join(privateDirectory, "context.json"), privateContext);
      }
      if (artifacts.sourceImport !== undefined) {
        const privateDirectory = join(stagingDirectory, "private");
        await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
        await writeCanonicalJson(join(privateDirectory, "source-import.json"), artifacts.sourceImport);
        await writeCanonicalJson(join(stagingDirectory, "source-import-reference.json"), {
          sha256: artifacts.sourceImport.sha256,
          byteLength: artifacts.sourceImport.byteLength,
          modifiedAt: artifacts.sourceImport.modifiedAt
        });
      }
      if (artifacts.calculationContext !== undefined) {
        await writeCanonicalJson(join(stagingDirectory, "calculation-context.json"), artifacts.calculationContext);
      }

      const filePaths = await this.artifactPaths(stagingDirectory);
      const files = await Promise.all(filePaths.map(async (filePath): Promise<RevisionManifestFile> => {
        const fileStat = await stat(filePath);
        const relativePath = relative(stagingDirectory, filePath).split(sep).join("/");
        return {
          path: relativePath,
          byteLength: fileStat.size,
          sha256: `sha256:${await sha256File(filePath)}`,
          private: relativePath.startsWith("private/")
        };
      }));
      files.sort((left, right) => left.path.localeCompare(right.path, "en"));

      const semanticSource = artifacts.sourceImport === undefined ? undefined : {
        sha256: artifacts.sourceImport.sha256,
        byteLength: artifacts.sourceImport.byteLength
      };
      const contentFingerprint = artifacts.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
        ? computeRevisionContentFingerprintV4(AUDIT_CONTRACT_VERSION_V4, {
          publicInput: PublicBirthRecordV2Schema.parse(publicInput),
          timeEvidence: TimeEvidenceV2Schema.parse(artifacts.timeEvidence),
          charts: artifacts.charts as DualTrackChartSetV1,
          baziDetail: parseBoundBaziDetail({
            publicBirthRecord: PublicBirthRecordV2Schema.parse(publicInput),
            timeEvidence: TimeEvidenceV2Schema.parse(artifacts.timeEvidence),
            baseChartSet: artifacts.charts as DualTrackChartSetV1,
            detail: artifacts.baziDetail
          }),
          audit: AuditReportV2Schema.parse(artifacts.audit),
          calculationContext: CalculationContextV4StorageSchema.parse(artifacts.calculationContext),
          workflowStatus: artifacts.workflowStatus,
          auditContractVersion: AUDIT_CONTRACT_VERSION_V4,
          rules: artifacts.rules as never,
          dependencies: artifacts.dependencies as never
        })
        : computeRevisionContentFingerprint({
          publicInput,
          timeEvidence: artifacts.timeEvidence,
          charts: artifacts.charts,
          audit: artifacts.audit,
          sourceImport: semanticSource,
          calculationContext: artifacts.calculationContext,
          workflowStatus: artifacts.workflowStatus,
          auditContractVersion: artifacts.auditContractVersion,
          rules: artifacts.rules,
          dependencies: artifacts.dependencies
        });

      const manifest: RevisionManifest = {
        schemaVersion: "1.0.0",
        ...(artifacts.auditContractVersion === undefined
          ? {}
          : { auditContractVersion: artifacts.auditContractVersion }),
        caseId,
        revisionId,
        workflowStatus: artifacts.workflowStatus,
        createdAt: this.now().toISOString(),
        rules: artifacts.rules,
        dependencies: artifacts.dependencies,
        contentFingerprint,
        files
      };
      await writeCanonicalJson(join(stagingDirectory, "manifest.json"), manifest);

      const stored: StoredRevision = {
        caseId,
        revisionId,
        workflowStatus: artifacts.workflowStatus,
        directory: targetDirectory,
        contentFingerprint
      };
      await this.beforeCommit?.(stored);
      await this.verifyStagingManifest(stagingDirectory, manifest);
      try {
        await this.verifyCommittedManifest(
          stagingDirectory,
          caseId,
          revisionId,
          verifiedEarlierManifests
        );
      } catch (error) {
        throw new CaseStoreError(
          "STAGING_INTEGRITY_MISMATCH",
          "暂存修订未通过清单完整性校验",
          { cause: error }
        );
      }
      if (await pathExists(targetDirectory)) {
        throw new CaseStoreError("REVISION_EXISTS", `${caseId}/${revisionId} 已存在，不能覆盖`);
      }
      await syncDirectory(stagingDirectory);
      await rename(stagingDirectory, targetDirectory);
      await syncDirectory(revisionsDirectory);
      return stored;
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async listCases(): Promise<Array<Record<string, unknown>>> {
    const caseIds = await readdir(this.casesDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const rows: Array<Record<string, unknown>> = [];
    for (const caseId of caseIds.filter((value) => CASE_ID.test(value)).sort()) {
      const manifests = await this.verifyCommittedLineage(caseId);
      const entries = await this.validateIdentityLineage(caseId, manifests);
      const revisions = [...manifests.keys()];
      const revisionId = revisions.at(-1);
      if (revisionId === undefined) continue;
      const manifest = manifests.get(revisionId)!;
      const entry = entries.get(revisionId)!;
      const { input, auditEvidence } = entry;
      rows.push({
        caseId,
        alias: input.alias,
        latestRevisionId: revisionId,
        workflowStatus: manifest.workflowStatus,
        auditLevel: auditEvidence.audit.auditLevel,
        auditEvidenceStatus: auditEvidence.status,
        contentFingerprint: manifest.contentFingerprint
      });
    }
    return rows;
  }

  async readRevision(caseId: string, revisionId: string, options: ReadRevisionOptions = {}): Promise<Record<string, unknown>> {
    const revisionDirectory = this.revisionDirectory(caseId, revisionId);
    const entries = await this.validateIdentityLineage(caseId, await this.verifyCommittedLineage(caseId, revisionId));
    const { manifest, input, auditEvidence } = entries.get(revisionId)!;
    const [timeEvidence, charts] = await Promise.all([
      readJson<unknown>(join(revisionDirectory, "time-evidence.json")),
      readJson<unknown>(join(revisionDirectory, "charts.json"))
    ]);
    const publicManifest = options.includePrivate === true
      ? manifest
      : {
        ...manifest,
        files: (manifest as RevisionManifest).files.filter((file) => !file.private)
      };
    const result: Record<string, unknown> = {
      input,
      timeEvidence,
      charts,
      audit: auditEvidence.audit,
      auditMarkdown: auditEvidence.auditMarkdown,
      reportReferenceMarkdown: auditEvidence.reportReferenceMarkdown,
      auditEvidence: {
        status: auditEvidence.status,
        allowedAnalysisModes: auditEvidence.allowedAnalysisModes
      },
      manifest: publicManifest,
      ruleEvidence: {
        xinjiangLocation: manifest.rules.xinjiangLocation === undefined
          ? { status: "legacy_missing", manifestValue: null }
          : { status: "recorded", manifestValue: manifest.rules.xinjiangLocation },
        unknownBirthplace: manifest.rules.unknownBirthplace === undefined
          ? { status: "historical_missing", manifestValue: null }
          : { status: "recorded", manifestValue: manifest.rules.unknownBirthplace }
      }
    };
    if (manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
      result.baziDetail = parseBoundBaziDetail({
        publicBirthRecord: PublicBirthRecordV2Schema.parse(input),
        timeEvidence: TimeEvidenceV2Schema.parse(timeEvidence),
        baseChartSet: charts as DualTrackChartSetV1,
        detail: await readJson(join(revisionDirectory, "bazi-detail.json"))
      });
    }
    if (auditEvidence.legacyAudit !== undefined) {
      result.legacyAudit = auditEvidence.legacyAudit;
    }
    if (options.includePrivate === true) {
      const privatePath = join(revisionDirectory, "private", "identity.json");
      if (await pathExists(privatePath)) {
        result.privateIdentity = await readJson(privatePath);
      }
      const sourceImportPath = join(revisionDirectory, "private", "source-import.json");
      if (await pathExists(sourceImportPath)) {
        result.sourceImport = await readJson(sourceImportPath);
      }
      const privateContextPath = join(revisionDirectory, "private", "context.json");
      if (await pathExists(privateContextPath)) {
        result.privateContext = await readJson(privateContextPath);
      }
    }
    const importReferencePath = join(revisionDirectory, "source-import-reference.json");
    if (await pathExists(importReferencePath)) {
      result.sourceImportReference = await readJson(importReferencePath);
    }
    const calculationContextPath = join(revisionDirectory, "calculation-context.json");
    if (await pathExists(calculationContextPath)) {
      result.calculationContext = await readJson(calculationContextPath);
    }
    return result;
  }

  async inspectLegacySource(sourcePath: string): Promise<LegacySourceRecord> {
    if (sourcePath.includes("\0")) {
      throw new CaseStoreError("INVALID_SOURCE_PATH", "旧案来源路径无效");
    }
    const absolutePath = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(sourcePath);
    const sourceStat = await stat(absolutePath);
    if (!sourceStat.isFile()) {
      throw new CaseStoreError("SOURCE_NOT_FILE", "旧案来源必须是普通文件");
    }
    return {
      sourcePath: absolutePath,
      fileName: basename(absolutePath),
      byteLength: sourceStat.size,
      modifiedAt: sourceStat.mtime.toISOString(),
      sha256: `sha256:${await sha256File(absolutePath)}`
    };
  }

  async exportRevision(
    caseId: string,
    revisionId: string,
    options: ExportRevisionOptions = {}
  ): Promise<{ directory: string; redacted: boolean; auditEvidenceStatus: AuditEvidenceStatus }> {
    const verified = await this.verifiedExportSource(caseId, revisionId);
    const includePrivate = options.includePrivate === true;
    await this.ensureExportsDirectory();
    const suffix = includePrivate ? "private" : "redacted";
    const targetDirectory = this.safePath(this.exportsDirectory, `${caseId}-${revisionId}-${suffix}`);
    if (await pathExists(targetDirectory)) {
      throw new CaseStoreError("EXPORT_EXISTS", "同名证据导出已存在，不能覆盖");
    }
    const stagingDirectory = this.safePath(this.exportsDirectory, `.${caseId}-${revisionId}-${suffix}.tmp-${randomUUID()}`);
    await mkdir(stagingDirectory, { mode: 0o700 });

    try {
      const result = await this.writeVerifiedExportDirectory(
        caseId,
        revisionId,
        stagingDirectory,
        includePrivate,
        this.now().toISOString(),
        verified
      );
      await rename(stagingDirectory, targetDirectory);
      await syncDirectory(this.exportsDirectory);
      return {
        directory: targetDirectory,
        ...result
      };
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async downloadRevisionArchive(
    caseId: string,
    revisionId: string,
    options: ExportRevisionOptions = {}
  ): Promise<RevisionDownloadArchive> {
    const includePrivate = options.includePrivate === true;
    const verified = await this.verifiedExportSource(caseId, revisionId);
    await this.ensureExportsDirectory();
    const temporaryDirectory = await mkdtemp(join(this.exportsDirectory, ".download-"));
    try {
      const result = await this.writeVerifiedExportDirectory(
        caseId,
        revisionId,
        temporaryDirectory,
        includePrivate,
        verified.sourceManifest.createdAt,
        verified
      );
      return {
        filename: `${caseId}-${revisionId}-${includePrivate ? "private" : "redacted"}.tar.gz`,
        contentType: "application/gzip",
        bytes: await archiveEvidenceDirectory(temporaryDirectory),
        ...result
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async verifiedExportSource(caseId: string, revisionId: string): Promise<VerifiedExportSource> {
    const revisionDirectory = this.revisionDirectory(caseId, revisionId);
    const entries = await this.validateIdentityLineage(
      caseId,
      await this.verifyCommittedLineage(caseId, revisionId)
    );
    const { manifest: sourceManifest, auditEvidence } = entries.get(revisionId)!;
    return { revisionDirectory, sourceManifest, auditEvidence };
  }

  private async writeVerifiedExportDirectory(
    caseId: string,
    revisionId: string,
    targetDirectory: string,
    includePrivate: boolean,
    exportedAt: string,
    verifiedSource?: VerifiedExportSource
  ): Promise<{ redacted: boolean; auditEvidenceStatus: AuditEvidenceStatus }> {
    const verified = verifiedSource ?? await this.verifiedExportSource(caseId, revisionId);
    const { revisionDirectory, sourceManifest, auditEvidence } = verified;
    const filesToCopy = sourceManifest.files.filter((file) => (
      (includePrivate || !file.private)
      && file.path !== "audit.md"
      && file.path !== "report-reference.md"
      && !(auditEvidence.status === "legacy_unvalidated" && file.path === "audit.json")
    ));
    for (const file of filesToCopy) {
      const source = this.safePath(revisionDirectory, file.path);
      const destination = this.safePath(targetDirectory, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination);
    }
    if (auditEvidence.status === "legacy_unvalidated") {
      await copyFile(
        this.safePath(revisionDirectory, "audit.json"),
        this.safePath(targetDirectory, "legacy-audit-source.json")
      );
      await writeCanonicalJson(join(targetDirectory, "audit.json"), auditEvidence.audit);
    }
    await writeDurableText(join(targetDirectory, "audit.md"), auditEvidence.auditMarkdown);
    await writeDurableText(join(targetDirectory, "report-reference.md"), auditEvidence.reportReferenceMarkdown);
    const exportedFiles = await this.artifactPaths(targetDirectory);
    const manifestFiles = await Promise.all(exportedFiles.map(async (filePath): Promise<RevisionManifestFile> => {
      const fileStat = await stat(filePath);
      const relativePath = relative(targetDirectory, filePath).split(sep).join("/");
      return {
        path: relativePath,
        byteLength: fileStat.size,
        sha256: `sha256:${await sha256File(filePath)}`,
        private: relativePath.startsWith("private/")
      };
    }));
    manifestFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
    await writeCanonicalJson(join(targetDirectory, "manifest.json"), {
      schemaVersion: "1.0.0",
      ...(auditEvidence.revisionGeneration === "modern"
        ? { auditContractVersion: sourceManifest.auditContractVersion }
        : {}),
      revisionGeneration: auditEvidence.revisionGeneration,
      ...(auditEvidence.approvedIdentity === undefined
        ? {}
        : {
            rules: auditEvidence.approvedIdentity.rules,
            dependencies: auditEvidence.approvedIdentity.dependencies
          }),
      caseId,
      revisionId,
      exportedAt,
      redacted: !includePrivate,
      auditEvidenceStatus: auditEvidence.status,
      sourceContentFingerprint: sourceManifest.contentFingerprint,
      files: manifestFiles
    });
    await syncDirectory(targetDirectory);
    return { redacted: !includePrivate, auditEvidenceStatus: auditEvidence.status };
  }

  private async ensureExportsDirectory(): Promise<void> {
    await mkdir(this.exportsDirectory, { recursive: true, mode: 0o700 });
    const status = await lstat(this.exportsDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new CaseStoreError("UNSAFE_EXPORTS_DIRECTORY", "证据导出目录不是安全的本地目录");
    }
  }

  private revisionsDirectory(caseId: string): string {
    assertCaseId(caseId);
    return this.safePath(this.casesDirectory, caseId, "revisions");
  }

  private revisionDirectory(caseId: string, revisionId: string): string {
    assertCaseId(caseId);
    assertRevisionId(revisionId);
    return this.safePath(this.revisionsDirectory(caseId), revisionId);
  }

  private safePath(baseDirectory: string, ...segments: string[]): string {
    const base = resolve(baseDirectory);
    const target = resolve(base, ...segments);
    const relativeTarget = relative(base, target);
    if (relativeTarget === "" || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== ".." && !isAbsolute(relativeTarget))) {
      return target;
    }
    throw new CaseStoreError("PATH_OUTSIDE_ROOT", "路径超出允许目录");
  }

  private async reserveRevisionId(
    revisionsDirectory: string,
    revisionId: string
  ): Promise<{ revisionId: string; path: string }> {
    assertRevisionId(revisionId);
    const targetDirectory = this.safePath(revisionsDirectory, revisionId);
    if (await pathExists(targetDirectory)) {
      throw new CaseStoreError("REVISION_EXISTS", `${revisionId} 已存在，不能覆盖`);
    }
    const reservationPath = this.safePath(revisionsDirectory, `.${revisionId}.reserve`);
    let handle;
    try {
      handle = await open(reservationPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CaseStoreError("REVISION_EXISTS", `${revisionId} 已被其他写操作占用`, { cause: error });
      }
      throw error;
    } finally {
      await handle?.close();
    }
    return { revisionId, path: reservationPath };
  }

  private async verifyStagingManifest(
    stagingDirectory: string,
    expectedManifest: RevisionManifest
  ): Promise<void> {
    try {
      const manifestPath = join(stagingDirectory, "manifest.json");
      const diskManifest = await readJson<RevisionManifest>(manifestPath);
      if (canonicalJson(diskManifest) !== canonicalJson(expectedManifest)) {
        throw new Error("manifest changed after generation");
      }

      const actualPaths = (await this.artifactPaths(stagingDirectory))
        .map((path) => relative(stagingDirectory, path).split(sep).join("/"));
      const manifestPaths = expectedManifest.files.map((file) => file.path);
      if (canonicalJson(actualPaths) !== canonicalJson(manifestPaths)) {
        throw new Error("manifest file set does not match staging directory");
      }
      assertMarkerSelectedFixedFiles(expectedManifest.auditContractVersion, manifestPaths);

      for (const file of expectedManifest.files) {
        const path = this.safePath(stagingDirectory, file.path);
        const fileStat = await lstat(path);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error(`${file.path} is not a regular file`);
        }
        if (fileStat.size !== file.byteLength || `sha256:${await sha256File(path)}` !== file.sha256) {
          throw new Error(`${file.path} does not match its manifest entry`);
        }
      }
    } catch (error) {
      throw new CaseStoreError("STAGING_INTEGRITY_MISMATCH", "暂存修订未通过清单完整性校验", { cause: error });
    }
  }

  private async verifyCommittedManifest(
    revisionDirectory: string,
    expectedCaseId: string,
    expectedRevisionId: string,
    verifiedEarlierManifests: ReadonlyMap<string, RevisionManifest>
  ): Promise<RevisionManifest> {
    let revisionStat;
    try {
      revisionStat = await lstat(revisionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new CaseStoreError(
        "COMMITTED_INTEGRITY_MISMATCH",
        "已提交修订未通过清单完整性校验",
        { cause: error }
      );
    }
    if (!revisionStat.isDirectory() || revisionStat.isSymbolicLink()) {
      throw new CaseStoreError(
        "COMMITTED_INTEGRITY_MISMATCH",
        "已提交修订未通过清单完整性校验"
      );
    }

    try {
      const manifestPath = this.safePath(revisionDirectory, "manifest.json");
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error("manifest is not a regular file");
      }
      const manifest = await readJson<RevisionManifest>(manifestPath);
      if (
        manifest.schemaVersion !== "1.0.0"
        || manifest.caseId !== expectedCaseId
        || manifest.revisionId !== expectedRevisionId
        || typeof manifest.workflowStatus !== "string"
        || !(WORKFLOW_STATUSES as readonly string[]).includes(manifest.workflowStatus)
        || !/^sha256:[a-f0-9]{64}$/u.test(manifest.contentFingerprint)
        || !isStringRecord(manifest.rules)
        || !isStringRecord(manifest.dependencies)
        || typeof manifest.createdAt !== "string"
        || !Number.isFinite(Date.parse(manifest.createdAt))
        || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
        || !Array.isArray(manifest.files)
      ) {
        throw new Error("manifest envelope is invalid");
      }

      const actualPaths = (await this.artifactPaths(revisionDirectory))
        .map((path) => relative(revisionDirectory, path).split(sep).join("/"));
      const manifestPaths = manifest.files.map((file) => file.path);
      if (canonicalJson(actualPaths) !== canonicalJson(manifestPaths)) {
        throw new Error("manifest file set does not match committed directory");
      }
      assertMarkerSelectedFixedFiles(manifest.auditContractVersion, manifestPaths);

      for (const file of manifest.files) {
        if (
          typeof file.path !== "string"
          || !Number.isSafeInteger(file.byteLength)
          || file.byteLength < 0
          || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)
          || typeof file.private !== "boolean"
          || file.private !== file.path.startsWith("private/")
        ) {
          throw new Error("manifest entry is invalid");
        }
        const path = this.safePath(revisionDirectory, file.path);
        const fileStat = await lstat(path);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          throw new Error(`${file.path} is not a regular file`);
        }
        if (fileStat.size !== file.byteLength || `sha256:${await sha256File(path)}` !== file.sha256) {
          throw new Error(`${file.path} does not match its manifest entry`);
        }
      }

      const fileSet = new Set(manifestPaths);
      const [publicInput, timeEvidence, charts, audit] = await Promise.all([
        readJson<Record<string, unknown>>(join(revisionDirectory, "input.json")),
        readJson<unknown>(join(revisionDirectory, "time-evidence.json")),
        readJson<unknown>(join(revisionDirectory, "charts.json")),
        readJson<unknown>(join(revisionDirectory, "audit.json"))
      ]);
      const calculationContext = fileSet.has("calculation-context.json")
        ? await readJson<Record<string, unknown>>(join(revisionDirectory, "calculation-context.json"))
        : undefined;
      const rawBaziDetail = fileSet.has("bazi-detail.json")
        ? await readJson<unknown>(join(revisionDirectory, "bazi-detail.json"))
        : undefined;
      if (manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
        CalculationContextV4StorageSchema.parse(calculationContext);
      } else if (manifest.auditContractVersion === AUDIT_CONTRACT_VERSION) {
        z.union([
          CalculationContextV2StorageSchema,
          CalculationContextV2FallbackStorageSchema
        ]).parse(calculationContext);
      }
      let sourceImport: { sha256: string; byteLength: number } | undefined;
      if (fileSet.has("source-import-reference.json")) {
        const reference = await readJson<unknown>(join(revisionDirectory, "source-import-reference.json"));
        if (
          !isObject(reference)
          || typeof reference.sha256 !== "string"
          || !/^sha256:[a-f0-9]{64}$/u.test(reference.sha256)
          || !Number.isSafeInteger(reference.byteLength)
          || (reference.byteLength as number) < 0
        ) {
          throw new Error("source import reference is invalid");
        }
        sourceImport = {
          sha256: reference.sha256,
          byteLength: reference.byteLength as number
        };
      }
      const expectedContentFingerprint = manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
        ? await (async () => {
          const parsedInput = PublicBirthRecordV2Schema.parse(publicInput);
          const parsedEvidence = TimeEvidenceV2Schema.parse(timeEvidence);
          const parsedAudit = AuditReportV2Schema.parse(
            parseAuditReportForContract(AUDIT_CONTRACT_VERSION_V4, audit)
          );
          const baziDetail = parseBoundBaziDetail({
            publicBirthRecord: parsedInput,
            timeEvidence: parsedEvidence,
            baseChartSet: charts as DualTrackChartSetV1,
            detail: rawBaziDetail
          });
          const parsedContext = CalculationContextV4StorageSchema.parse(calculationContext);
          const approvedSourceRecordFingerprint = sourceRecordFingerprint(parsedInput);
          const privateContext = fileSet.has("private/context.json")
            ? StoredPrivateContextSchema.parse(
              await readJson<unknown>(join(revisionDirectory, "private", "context.json"))
            )
            : StoredPrivateContextSchema.parse({});
          const derivedProvenanceFlags = [
            parsedInput.providedTime.basis === "apparent_solar_provided"
              ? "provided_time_apparent_solar"
              : "provided_time_civil_clock",
            ...(privateContext.providedTimeSourceNote === undefined
              ? []
              : ["provided_time_source_note_present"])
          ];
          if (
            parsedContext.timeInputBasis !== parsedInput.providedTime.basis
            || canonicalJson(parsedContext.targetYears) !== canonicalJson((charts as DualTrackChartSetV1).targetYears)
            || canonicalJson(parsedContext.provenanceFlags) !== canonicalJson(derivedProvenanceFlags)
            || parsedEvidence.sourceRecordFingerprint !== approvedSourceRecordFingerprint
          ) {
            throw new Error("v4 calculation context does not match stored authority");
          }
          const auditInputBase = {
            auditReportId: parsedAudit.auditReportId,
            revisionId: parsedAudit.revisionId,
            birthRecord: parsedInput,
            timeEvidence: parsedEvidence,
            chartSet: charts as DualTrackChartSetV1,
            versionEvidence: deriveVersionEvidence(charts as DualTrackChartSetV1, parsedEvidence),
            workflowStatus: manifest.workflowStatus,
            manualDecision: parsedAudit.manualDecision,
            provenanceFlags: derivedProvenanceFlags,
            privateMetadataPresence: {
              providedTimeSourceNote: privateContext.providedTimeSourceNote !== undefined
            },
            precisionCoverage: parsedContext.precisionCoverage as never
          };
          const candidateArtifactManifests = this.storedAuditArtifactManifestCandidates(
            parsedAudit,
            parsedContext,
            approvedSourceRecordFingerprint,
            verifiedEarlierManifests
          );
          const matchingAudits = candidateArtifactManifests.flatMap((artifactManifest) => {
            try {
              const rebuiltAudit = buildDetailedAuditReport(AUDIT_CONTRACT_VERSION_V4, {
                auditInput: { ...auditInputBase, artifactManifest },
                baziDetail
              });
              return canonicalJson(rebuiltAudit) === canonicalJson(parsedAudit) ? [rebuiltAudit] : [];
            } catch {
              return [];
            }
          });
          if (matchingAudits.length !== 1) {
            throw new Error("v4 audit does not have one bound stored authority");
          }
          return computeRevisionContentFingerprintV4(AUDIT_CONTRACT_VERSION_V4, {
            publicInput: parsedInput,
            timeEvidence: parsedEvidence,
            charts: charts as DualTrackChartSetV1,
            baziDetail,
            audit: parsedAudit,
            calculationContext: parsedContext,
            workflowStatus: manifest.workflowStatus,
            auditContractVersion: AUDIT_CONTRACT_VERSION_V4,
            rules: manifest.rules as never,
            dependencies: manifest.dependencies as never
          });
        })()
        : computeRevisionContentFingerprint({
          publicInput,
          timeEvidence,
          charts,
          audit,
          sourceImport,
          calculationContext,
          workflowStatus: manifest.workflowStatus,
          auditContractVersion: manifest.auditContractVersion,
          rules: manifest.rules,
          dependencies: manifest.dependencies
        });
      if (manifest.contentFingerprint !== expectedContentFingerprint) {
        throw new Error("semantic content fingerprint does not match committed artifacts");
      }
      return manifest;
    } catch (error) {
      if (error instanceof CaseStoreError && error.code === "COMMITTED_INTEGRITY_MISMATCH") {
        throw error;
      }
      throw new CaseStoreError(
        "COMMITTED_INTEGRITY_MISMATCH",
        "已提交修订未通过清单完整性校验",
        { cause: error }
      );
    }
  }

  private storedAuditArtifactManifestCandidates(
    audit: AuditReportV2,
    calculationContext: z.infer<typeof CalculationContextV4StorageSchema>,
    approvedSourceRecordFingerprint: string,
    verifiedEarlierManifests: ReadonlyMap<string, RevisionManifest>
  ): Array<{ artifacts: Array<{ artifactId: string; sha256: string }> }> {
    const references = new Set(
      audit.manualDecision.evidenceRefs.filter((reference) => reference.startsWith("artifact:"))
    );
    const proof = calculationContext.precisionCoverage.proof;
    if (proof !== null) {
      if (proof.sourceRecordFingerprint !== approvedSourceRecordFingerprint) return [];
      references.add(proof.artifactId);
    }
    if (references.size === 0) return [{ artifacts: [] }];
    return [...verifiedEarlierManifests.values()].flatMap((candidateManifest) => {
      const artifacts = candidateManifest.files
        .filter((file) => (
          !file.private
          && !file.path.startsWith("private/")
          && references.has(`artifact:${file.path}`)
        ))
        .map((file) => ({ artifactId: `artifact:${file.path}`, sha256: file.sha256 }));
      if (
        proof !== null
        && !artifacts.some((artifact) => (
          artifact.artifactId === proof.artifactId
          && artifact.sha256 === proof.artifactSha256
        ))
      ) {
        return [];
      }
      return artifacts.length === references.size ? [{ artifacts }] : [];
    });
  }

  private async verifyCommittedLineage(
    caseId: string,
    throughRevisionId?: string
  ): Promise<Map<string, RevisionManifest>> {
    assertCaseId(caseId);
    if (throughRevisionId !== undefined) assertRevisionId(throughRevisionId);
    const revisionsDirectory = this.revisionsDirectory(caseId);
    let entries: string[];
    try {
      entries = await readdir(revisionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && throughRevisionId === undefined) {
        return new Map();
      }
      throw error;
    }
    const allRevisionIds = entries.filter((entry) => REVISION_ID.test(entry)).sort();
    if (throughRevisionId !== undefined && !allRevisionIds.includes(throughRevisionId)) {
      await lstat(this.safePath(revisionsDirectory, throughRevisionId));
    }
    const throughNumber = throughRevisionId === undefined
      ? Number(allRevisionIds.at(-1)?.slice(1) ?? 0)
      : Number(throughRevisionId.slice(1));
    const revisionIds = allRevisionIds.filter((revisionId) => Number(revisionId.slice(1)) <= throughNumber);
    const expectedIds = Array.from(
      { length: throughNumber },
      (_unused, index) => `R${String(index + 1).padStart(3, "0")}`
    );
    if (canonicalJson(revisionIds) !== canonicalJson(expectedIds)) {
      throw new CaseStoreError(
        "COMMITTED_INTEGRITY_MISMATCH",
        "已提交修订链不连续或缺失"
      );
    }
    const manifests = new Map<string, RevisionManifest>();
    for (const revisionId of revisionIds) {
      manifests.set(
        revisionId,
        await this.verifyCommittedManifest(
          this.safePath(revisionsDirectory, revisionId),
          caseId,
          revisionId,
          manifests
        )
      );
    }
    return manifests;
  }

  private async validateIdentityLineage(
    caseId: string,
    manifests: Map<string, RevisionManifest>
  ): Promise<Map<string, ValidatedLineageEntry>> {
    const entries = new Map<string, ValidatedLineageEntry>();
    for (const [revisionId, manifest] of manifests) {
      const directory = this.revisionDirectory(caseId, revisionId);
      const [input, rawAudit] = await Promise.all([
        readJson<Record<string, unknown>>(join(directory, "input.json")),
        readJson<Record<string, unknown>>(join(directory, "audit.json"))
      ]);
      entries.set(revisionId, {
        manifest,
        input,
        rawAudit,
        auditEvidence: auditEvidenceView(input, rawAudit, manifest)
      });
    }
    return entries;
  }

  private async artifactPaths(directory: string): Promise<string[]> {
    const result: string[] = [];
    const visit = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          if (!(current === directory && entry.name === "manifest.json")) {
            result.push(path);
          }
        } else if (!entry.isFile()) {
          throw new CaseStoreError("UNSAFE_ARTIFACT_ENTRY", `修订暂存区包含非普通文件：${entry.name}`);
        }
      }
    };
    await visit(directory);
    return result.sort();
  }

  private async withCaseLock<T>(caseId: string, operation: () => Promise<T>): Promise<T> {
    assertCaseId(caseId);
    const previous = this.caseLocks.get(caseId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    this.caseLocks.set(caseId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.caseLocks.get(caseId) === current) {
        this.caseLocks.delete(caseId);
      }
    }
  }
}
