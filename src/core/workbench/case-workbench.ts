import { z } from "zod";

import {
  AUDIT_CONTRACT_VERSION_V4,
  buildAuditReport,
  buildDetailedAuditReport,
  deriveVersionEvidence,
  type AuditReportV1
} from "../audit/index.js";
import {
  assertTargetYearsWithinSharedSupportedSet,
  BaziDetailGenerationError,
  buildBaziDetailV1,
  calculateCandidateCharts,
  resolveSharedSupportedTargetYears,
  TargetYearOutsideSharedSupportedSetError,
  type BaziDetailSourcesV1,
  type BaziDetailV1,
  type DualTrackChartSetV1
} from "../charts/index.js";
import {
  inspectLegacyBirthRecords,
  loadSelectedLegacyBirthRecord,
  type LegacyInspection
} from "../import/legacy-import.js";
import {
  CaseStore,
  CaseStoreError,
  type LegacySourceRecord,
  type RevisionArtifacts,
  type WorkflowStatus
} from "../storage/case-store.js";
import { normalizeBirthTime } from "../time/normalize-birth-time.js";
import { normalizeProvidedTime, ProvidedTimeNoValidCandidateError } from "../time/normalize-provided-time.js";
import { publicBirthRecordMaterial } from "../time/source-record-fingerprint.js";
import { BirthRecordV1Schema, type BirthRecordV1 } from "../../shared/contracts.js";
import {
  BirthRecordV2Schema,
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema,
  type BirthRecordV2,
  type PublicBirthRecordV2
} from "../../shared/provided-time-contracts.js";
import {
  classifyUnknownBirthplaceBasis,
  unknownBirthplaceBasisIssues
} from "../../shared/unknown-birthplace.js";
import {
  deriveProvenanceFlags,
  renderAuditMarkdown,
  renderReportReferenceMarkdown
} from "./artifacts.js";
import {
  AUDIT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION_V2,
  deriveApprovedRevisionIdentity
} from "./revision-version-identity.js";
import {
  buildChartDocumentV1,
  CALCULATOR_VERSION,
  chartDocumentFilename,
  ChartDocumentExportRequestSchema,
  type ChartDocumentV1
} from "./chart-document.js";

const CASE_ID = z.string().regex(/^CS-\d{4}-\d{3}$/u);
const REVISION_ID = z.string().regex(/^R\d{3}$/u);
const TargetYearsSchema = z.array(z.number().int().min(1900).max(2099)).max(50).default([]);
const LegacyTargetYearsSchema = z.array(z.number().int().min(1900).max(2099)).min(1).max(50);
const TargetYearsV2Schema = z.array(z.number().int().min(1900).max(2099)).max(50)
  .superRefine((years, context) => {
    if (new Set(years).size !== years.length) {
      context.addIssue({ code: "custom", message: "目标流年不得重复" });
    }
  })
  .transform((years) => [...years].sort((left, right) => left - right))
  .default([]);
const WorkflowForCalculationSchema = z.enum(["draft", "review"]).default("review");
const LegacySourceLinkSchema = z.object({
  sourcePath: z.string().min(1),
  expectedSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u)
}).strict();
const TargetYearsUpdateRequestSchema = z.object({
  targetYears: TargetYearsV2Schema
}).strict();

export const UnknownBirthplaceAttestationV1Schema = z.object({
  mode: z.literal("beijing_time_basis"),
  confirmedBy: z.literal("local_operator"),
  noticeVersion: z.literal("CyberSaga-Unknown-Birthplace-Notice-v1")
}).strict();

export const CalculationRevisionRequestSchema = z.object({
  birthRecord: BirthRecordV1Schema,
  targetYears: TargetYearsSchema,
  workflowStatus: WorkflowForCalculationSchema,
  provenanceFlags: z.array(z.string().min(1)).max(30).default([]),
  legacySource: LegacySourceLinkSchema.optional(),
  unknownBirthplaceAttestation: UnknownBirthplaceAttestationV1Schema.optional()
}).strict();

const ProvidedTimePrivateIngressSchema = z.object({
  birthplaceNote: z.string().trim().min(1).optional()
}).strict();

const StoredProvidedTimePrivateContextSchema = z.object({
  privateName: z.string().trim().min(1).optional(),
  birthplaceNote: z.string().trim().min(1).optional(),
  providedTimeSourceNote: z.string().trim().min(1).optional()
}).strict();

export const CalculationRevisionV2RequestSchema = z.object({
  birthRecord: BirthRecordV2Schema,
  targetYears: TargetYearsV2Schema,
  workflowStatus: WorkflowForCalculationSchema,
  privateContext: ProvidedTimePrivateIngressSchema.optional()
}).strict().superRefine((request, context) => {
  const birthYear = Number(request.birthRecord.calendar.date.slice(0, 4));
  if (request.targetYears.some((year) => year < birthYear)) {
    context.addIssue({
      code: "custom",
      message: "目标流年不能早于出生年份",
      path: ["targetYears"]
    });
  }
});

const CalculationRevisionIngressSchema = CalculationRevisionRequestSchema.extend({
  unknownBirthplaceAttestation: z.unknown().optional()
});

export const DecisionRequestSchema = z.object({
  status: z.enum(["selected", "deferred", "retained_all", "voided"]),
  selectedCandidateId: z.string().min(1).nullable().optional(),
  rationale: z.string().trim().min(8),
  workflowStatus: z.enum(["review", "verified", "void"]),
  evidenceRefs: z.array(z.string().min(1)).max(50).default([])
}).strict().superRefine((decision, context) => {
  if ((decision.status === "selected") !== (typeof decision.selectedCandidateId === "string")) {
    context.addIssue({
      code: "custom",
      message: "selected 决定必须且只能指定一个候选",
      path: ["selectedCandidateId"]
    });
  }
  if ((decision.status === "voided") !== (decision.workflowStatus === "void")) {
    context.addIssue({
      code: "custom",
      message: "voided 决定与 void 流程状态必须同时出现",
      path: ["workflowStatus"]
    });
  }
});

const CalculationContextSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  provenanceFlags: z.array(z.string().min(1)),
  unknownBirthplaceAttestation: UnknownBirthplaceAttestationV1Schema.optional(),
  precisionCoverage: z.object({
    mode: z.enum(["point", "interval", "branch"]),
    complete: z.boolean(),
    candidateIds: z.array(z.string().min(1)),
    note: z.string().min(1).nullable(),
    proof: z.unknown().nullable()
  }).strict()
}).strict();

export const CalculationContextV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50),
  timeInputBasis: z.enum(["apparent_solar_provided", "civil_clock_provided"]),
  provenanceFlags: z.array(z.enum([
    "provided_time_apparent_solar",
    "provided_time_civil_clock",
    "provided_time_source_note_present"
  ])),
  precisionCoverage: z.object({
    mode: z.enum(["point", "interval", "branch"]),
    complete: z.boolean(),
    candidateIds: z.array(z.string().min(1)),
    note: z.string().min(1).nullable(),
    proof: z.unknown().nullable()
  }).strict()
}).strict();

export const CalculationContextV2FallbackSchema = CalculationContextV2Schema.extend({
  baziDetailGenerationStatus: z.literal("retryable_failure")
}).strict();
const StoredCalculationContextV2Schema = z.union([
  CalculationContextV2Schema,
  CalculationContextV2FallbackSchema
]);

type CalculationRevisionRequest = z.infer<typeof CalculationRevisionRequestSchema>;
type CalculationRevisionIngressRequest = z.infer<typeof CalculationRevisionIngressSchema>;
type CalculationRevisionV2Request = z.infer<typeof CalculationRevisionV2RequestSchema>;
type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export class WorkbenchError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkbenchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CaseWorkbenchOptions {
  now?: () => Date;
  baziDetailBuilder?: (sources: BaziDetailSourcesV1) => BaziDetailV1;
}

export type BaziDetailAvailability =
  | { status: "ready"; supportedTargetYears: number[] }
  | { status: "can_generate"; supportedTargetYears: number[] }
  | { status: "retryable_failure"; supportedTargetYears: number[] }
  | { status: "reconfirm_required" };

export interface ResultCapabilities {
  baziDetail: BaziDetailAvailability;
  maxTargetYears: 50;
}

function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function precisionCoverage(record: BirthRecordV1, candidateIds: string[]) {
  const mode = record.birthTime.precision === "minute"
    ? "point" as const
    : record.birthTime.precision === "approximate"
      ? "interval" as const
      : "branch" as const;
  const complete = mode === "point";
  return {
    mode,
    complete,
    candidateIds,
    note: complete ? null : "当前修订只保存了代表钟表时间，尚未形成完整精度区间覆盖。",
    proof: null
  };
}

function providedTimePrecisionCoverage(record: PublicBirthRecordV2, candidateIds: string[]) {
  const mode = record.providedTime.precision === "minute"
    ? "point" as const
    : record.providedTime.precision === "approximate"
      ? "interval" as const
      : "branch" as const;
  const complete = mode === "point";
  return {
    mode,
    complete,
    candidateIds,
    note: complete ? null : "当前修订只保存了用户提供的代表时间，尚未形成完整精度区间覆盖。",
    proof: null
  };
}

function providedTimeProvenanceFlags(record: BirthRecordV2): string[] {
  return [
    record.providedTime.basis === "apparent_solar_provided"
      ? "provided_time_apparent_solar"
      : "provided_time_civil_clock",
    ...(record.providedTime.sourceNote === undefined ? [] : ["provided_time_source_note_present"])
  ];
}

function noManualDecision() {
  return {
    status: "none" as const,
    selectedCandidateId: null,
    rationale: null,
    decidedAt: null,
    decidedBy: null,
    evidenceRefs: [] as []
  };
}

function artifactManifest(
  snapshot: Record<string, unknown>,
  referencedArtifactIds: readonly string[]
): { artifacts: Array<{ artifactId: string; sha256: string }> } {
  const parsed = z.object({
    files: z.array(z.object({
      path: z.string(),
      sha256: z.string(),
      private: z.boolean().optional()
    }).passthrough())
  }).passthrough().safeParse(snapshot.manifest);
  const referenced = new Set(referencedArtifactIds.filter((reference) => reference.startsWith("artifact:")));
  return {
    artifacts: parsed.success
      ? parsed.data.files
        .filter((file) => (
          file.private !== true
          && !file.path.startsWith("private/")
          && referenced.has(`artifact:${file.path}`)
        ))
        .map((file) => ({ artifactId: `artifact:${file.path}`, sha256: file.sha256 }))
      : []
  };
}

function referencedArtifactIds(
  evidenceRefs: readonly string[],
  coverage: z.infer<typeof CalculationContextSchema>["precisionCoverage"]
): string[] {
  const references = new Set(evidenceRefs.filter((reference) => reference.startsWith("artifact:")));
  const proof = z.object({ artifactId: z.string() }).passthrough().safeParse(coverage.proof);
  if (proof.success) references.add(proof.data.artifactId);
  return [...references];
}

function publicRevision(stored: {
  caseId: string;
  revisionId: string;
  workflowStatus: WorkflowStatus;
  contentFingerprint: string;
}) {
  return {
    caseId: stored.caseId,
    revisionId: stored.revisionId,
    workflowStatus: stored.workflowStatus,
    contentFingerprint: stored.contentFingerprint
  };
}

function parseProvidedTimeRequest(raw: unknown): CalculationRevisionV2Request {
  const parsed = CalculationRevisionV2RequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorkbenchError(
      "INVALID_PROVIDED_TIME_INPUT",
      "用户提供时间的输入不完整或格式不正确",
      400
    );
  }
  return parsed.data;
}

export class CaseWorkbench {
  readonly store: CaseStore;
  private readonly now: () => Date;
  private readonly baziDetailBuilder: (sources: BaziDetailSourcesV1) => BaziDetailV1;

  constructor(dataRoot: string, options: CaseWorkbenchOptions = {}) {
    this.store = new CaseStore(dataRoot, { now: options.now });
    this.now = options.now ?? (() => new Date());
    this.baziDetailBuilder = options.baziDetailBuilder ?? buildBaziDetailV1;
  }

  async listCases(): Promise<Array<Record<string, unknown>>> {
    return this.store.listCases();
  }

  async readRevision(caseId: string, revisionId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.store.readRevision(CASE_ID.parse(caseId), REVISION_ID.parse(revisionId));
    return this.decorateResultSnapshot(snapshot);
  }

  async createCase(raw: unknown) {
    const request = parseProvidedTimeRequest(raw);
    return this.createProvidedTimeRevision(request, undefined);
  }

  async createRevision(caseId: string, raw: unknown) {
    const parsedCaseId = CASE_ID.parse(caseId);
    const request = parseProvidedTimeRequest(raw);
    if (request.birthRecord.caseId !== parsedCaseId) {
      throw new WorkbenchError("CASE_ID_MISMATCH", "路径案例编号与 BirthRecord 不一致");
    }
    const existingCase = (await this.store.listCases()).find((item) => item.caseId === parsedCaseId);
    if (existingCase === undefined) {
      throw new WorkbenchError("CASE_NOT_FOUND", "案例不存在，不能追加修订", 404);
    }
    return this.createProvidedTimeRevision(request, parsedCaseId);
  }

  async inspectLegacySource(sourcePath: string): Promise<LegacyInspection> {
    return inspectLegacyBirthRecords(this.store, sourcePath);
  }

  async importSelectedLegacy(raw: unknown) {
    const request = z.object({
      sourcePath: z.string().min(1),
      expectedSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      selector: z.string().min(1),
      targetYears: LegacyTargetYearsSchema,
      workflowStatus: WorkflowForCalculationSchema,
      provenanceFlags: z.array(z.string().min(1)).max(30).default([])
    }).strict().parse(raw);
    const selected = await loadSelectedLegacyBirthRecord(this.store, request);
    const calculationRequest: CalculationRevisionRequest = {
      birthRecord: selected.record,
      targetYears: request.targetYears,
      workflowStatus: request.workflowStatus,
      provenanceFlags: request.provenanceFlags,
      legacySource: {
        sourcePath: selected.source.sourcePath,
        expectedSha256: selected.source.sha256
      }
    };
    const exists = (await this.store.listCases()).some((item) => item.caseId === selected.record.caseId);
    return this.createHistoricalV1Revision(calculationRequest, exists ? selected.record.caseId : undefined);
  }

  async recordDecision(caseId: string, revisionId: string, raw: unknown) {
    const parsedCaseId = CASE_ID.parse(caseId);
    const parsedRevisionId = REVISION_ID.parse(revisionId);
    const decision = DecisionRequestSchema.parse(raw);
    const previous = await this.store.readRevision(parsedCaseId, parsedRevisionId, { includePrivate: true });
    const previousAudit = z.object({ workflowStatus: z.string() }).passthrough().parse(previous.audit);
    if (previousAudit.workflowStatus === "void") {
      throw new WorkbenchError("VOID_REVISION_IMMUTABLE", "已作废修订不能再产生人工决定", 409);
    }
    const manualDecision = {
      status: decision.status,
      selectedCandidateId: decision.status === "selected" ? decision.selectedCandidateId! : null,
      rationale: decision.rationale,
      decidedAt: isoSeconds(this.now()),
      decidedBy: "local_operator" as const,
      evidenceRefs: decision.evidenceRefs
    };
    const storedInput = z.record(z.string(), z.unknown()).parse(previous.input);
    if (storedInput.schemaVersion === "2.0.0") {
      const publicRecord = PublicBirthRecordV2Schema.parse(storedInput);
      const privateContext = StoredProvidedTimePrivateContextSchema.parse(previous.privateContext ?? {});
      const record = BirthRecordV2Schema.parse({
        ...publicRecord,
        ...(privateContext.privateName === undefined ? {} : { privateName: privateContext.privateName }),
        providedTime: {
          ...publicRecord.providedTime,
          ...(privateContext.providedTimeSourceNote === undefined
            ? {}
            : { sourceNote: privateContext.providedTimeSourceNote })
        }
      });
      const context = StoredCalculationContextV2Schema.parse(previous.calculationContext);
      return this.createProvidedTimeRevision({
        birthRecord: record,
        targetYears: context.targetYears,
        workflowStatus: "review",
        ...(privateContext.birthplaceNote === undefined
          ? {}
          : { privateContext: { birthplaceNote: privateContext.birthplaceNote } })
      }, parsedCaseId, {
        workflowStatus: decision.workflowStatus,
        manualDecision,
        artifactManifest: artifactManifest(
          previous,
          referencedArtifactIds(decision.evidenceRefs, context.precisionCoverage)
        ),
        precisionCoverage: context.precisionCoverage
      });
    }

    const privateIdentity = z.object({ privateName: z.string().min(1) }).safeParse(previous.privateIdentity);
    const record = BirthRecordV1Schema.parse({
      ...storedInput,
      ...(privateIdentity.success ? privateIdentity.data : {})
    });
    const context = CalculationContextSchema.parse(previous.calculationContext);
    const sourceImport = previous.sourceImport as LegacySourceRecord | undefined;
    return this.createHistoricalV1Revision({
      birthRecord: record,
      targetYears: context.targetYears,
      workflowStatus: "review",
      provenanceFlags: context.provenanceFlags,
      ...(context.unknownBirthplaceAttestation === undefined
        ? {}
        : { unknownBirthplaceAttestation: context.unknownBirthplaceAttestation })
    }, parsedCaseId, {
      workflowStatus: decision.workflowStatus,
      manualDecision,
      sourceImport,
      artifactManifest: artifactManifest(
        previous,
        referencedArtifactIds(decision.evidenceRefs, context.precisionCoverage)
      ),
      precisionCoverage: context.precisionCoverage
    });
  }

  async exportRevision(caseId: string, revisionId: string, includePrivate = false) {
    return this.store.exportRevision(CASE_ID.parse(caseId), REVISION_ID.parse(revisionId), { includePrivate });
  }

  async downloadRevisionArchive(caseId: string, revisionId: string, includePrivate = false) {
    return this.store.downloadRevisionArchive(
      CASE_ID.parse(caseId),
      REVISION_ID.parse(revisionId),
      { includePrivate }
    );
  }

  async downloadChartDocument(
    caseId: string,
    revisionId: string,
    raw: unknown
  ): Promise<{
    filename: string;
    contentType: "application/json; charset=utf-8";
    document: ChartDocumentV1;
  }> {
    const request = ChartDocumentExportRequestSchema.parse(raw);
    const parsedCaseId = CASE_ID.parse(caseId);
    const parsedRevisionId = REVISION_ID.parse(revisionId);
    const exportedAt = this.now();
    const storedRevision = await this.store.readRevision(parsedCaseId, parsedRevisionId, {
      includePrivate: true
    });
    const document = buildChartDocumentV1({
      calculatorVersion: CALCULATOR_VERSION,
      exportedAt,
      storedRevision,
      requestedCandidateId: request.candidateId,
      ...(request.targetYear === undefined ? {} : { targetYear: request.targetYear })
    });
    return {
      filename: chartDocumentFilename(exportedAt),
      contentType: "application/json; charset=utf-8" as const,
      document
    };
  }

  async updateTargetYears(caseId: string, revisionId: string, raw: unknown) {
    const parsedCaseId = CASE_ID.parse(caseId);
    const parsedRevisionId = REVISION_ID.parse(revisionId);
    const request = TargetYearsUpdateRequestSchema.parse(raw);
    const previous = await this.store.readRevision(parsedCaseId, parsedRevisionId, { includePrivate: true });
    const publicRecordResult = PublicBirthRecordV2Schema.safeParse(previous.input);
    if (!publicRecordResult.success) {
      throw new WorkbenchError(
        "BAZI_DETAIL_RECONFIRM_FINAL_TIME_REQUIRED",
        "请先重新确认最终排盘时间",
        409
      );
    }
    const privateContext = StoredProvidedTimePrivateContextSchema.parse(previous.privateContext ?? {});
    const context = StoredCalculationContextV2Schema.parse(previous.calculationContext);
    const fullRecord = BirthRecordV2Schema.parse({
      ...publicRecordResult.data,
      ...(privateContext.privateName === undefined ? {} : { privateName: privateContext.privateName }),
      providedTime: {
        ...publicRecordResult.data.providedTime,
        ...(privateContext.providedTimeSourceNote === undefined
          ? {}
          : { sourceNote: privateContext.providedTimeSourceNote })
      }
    });
    return this.createProvidedTimeRevision({
      birthRecord: fullRecord,
      targetYears: request.targetYears,
      workflowStatus: "review",
      ...(privateContext.birthplaceNote === undefined
        ? {}
        : { privateContext: { birthplaceNote: privateContext.birthplaceNote } })
    }, parsedCaseId, { precisionCoverage: context.precisionCoverage });
  }

  private async decorateResultSnapshot(
    snapshot: Record<string, unknown>,
    precomputedSupportedTargetYears?: readonly number[]
  ): Promise<Record<string, unknown>> {
    const manifest = z.object({ auditContractVersion: z.unknown().optional() }).passthrough().parse(snapshot.manifest);
    const provided = PublicBirthRecordV2Schema.safeParse(snapshot.input);
    if (
      !provided.success
      || (manifest.auditContractVersion !== AUDIT_CONTRACT_VERSION
        && manifest.auditContractVersion !== AUDIT_CONTRACT_VERSION_V4)
    ) {
      return {
        ...snapshot,
        baziDetail: null,
        resultCapabilities: {
          baziDetail: { status: "reconfirm_required" },
          maxTargetYears: 50
        } satisfies ResultCapabilities
      };
    }
    const evidence = TimeEvidenceV2Schema.parse(snapshot.timeEvidence);
    const charts = snapshot.charts as DualTrackChartSetV1;
    const supportedTargetYears = precomputedSupportedTargetYears === undefined
      ? resolveSharedSupportedTargetYears({
          publicBirthRecord: provided.data,
          timeEvidence: evidence,
          baseChartSet: charts
        })
      : [...precomputedSupportedTargetYears];
    const storedContext = StoredCalculationContextV2Schema.parse(snapshot.calculationContext);
    const retryable = "baziDetailGenerationStatus" in storedContext;
    const { baziDetailGenerationStatus: _hiddenStatus, ...publicCalculationContext } = retryable
      ? storedContext
      : { ...storedContext, baziDetailGenerationStatus: undefined };
    const availability: BaziDetailAvailability = manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
      ? { status: "ready", supportedTargetYears }
      : retryable
        ? { status: "retryable_failure", supportedTargetYears }
        : { status: "can_generate", supportedTargetYears };
    return {
      ...snapshot,
      calculationContext: publicCalculationContext,
      baziDetail: manifest.auditContractVersion === AUDIT_CONTRACT_VERSION_V4
        ? snapshot.baziDetail
        : null,
      resultCapabilities: {
        baziDetail: availability,
        maxTargetYears: 50
      } satisfies ResultCapabilities
    };
  }

  private async createProvidedTimeRevision(
    request: CalculationRevisionV2Request,
    expectedExistingCaseId: string | undefined,
    overrides: {
      workflowStatus?: WorkflowStatus;
      manualDecision?: Record<string, unknown>;
      artifactManifest?: { artifacts: Array<{ artifactId: string; sha256: string }> };
      precisionCoverage?: z.infer<typeof CalculationContextV2Schema>["precisionCoverage"];
    } = {}
  ) {
    const fullRecord = BirthRecordV2Schema.parse(request.birthRecord);
    if (expectedExistingCaseId !== undefined && expectedExistingCaseId !== fullRecord.caseId) {
      throw new WorkbenchError("CASE_ID_MISMATCH", "路径案例编号与用户提供时间记录不一致");
    }
    const publicRecord = PublicBirthRecordV2Schema.parse(publicBirthRecordMaterial(fullRecord));
    let evidence: ReturnType<typeof normalizeProvidedTime>;
    try {
      evidence = normalizeProvidedTime(publicRecord);
    } catch (error) {
      if (error instanceof ProvidedTimeNoValidCandidateError) {
        throw new WorkbenchError(
          "PROVIDED_TIME_NO_VALID_CANDIDATE",
          "这个日期与时间没有可用的排盘候选，请检查历法和日期",
          422
        );
      }
      throw error;
    }
    const capabilityCharts = calculateCandidateCharts(publicRecord, evidence, { targetYears: [] });
    const supportedTargetYears = resolveSharedSupportedTargetYears({
      publicBirthRecord: publicRecord,
      timeEvidence: evidence,
      baseChartSet: capabilityCharts
    });
    try {
      assertTargetYearsWithinSharedSupportedSet(request.targetYears, supportedTargetYears);
    } catch (error) {
      if (error instanceof TargetYearOutsideSharedSupportedSetError) {
        throw new WorkbenchError(
          "TARGET_YEAR_OUTSIDE_SHARED_SUPPORTED_SET",
          "超出当前排盘可计算运限",
          422
        );
      }
      throw error;
    }
    const charts = request.targetYears.length === 0
      ? capabilityCharts
      : calculateCandidateCharts(publicRecord, evidence, { targetYears: request.targetYears });
    const provenanceFlags = providedTimeProvenanceFlags(fullRecord);
    const coverage = overrides.precisionCoverage ?? providedTimePrecisionCoverage(
      publicRecord,
      evidence.candidates.map((candidate) => candidate.id)
    );
    const workflowStatus = overrides.workflowStatus ?? request.workflowStatus;
    const privateContext = {
      ...(fullRecord.privateName === undefined ? {} : { privateName: fullRecord.privateName }),
      ...(request.privateContext?.birthplaceNote === undefined
        ? {}
        : { birthplaceNote: request.privateContext.birthplaceNote }),
      ...(fullRecord.providedTime.sourceNote === undefined
        ? {}
        : { providedTimeSourceNote: fullRecord.providedTime.sourceNote })
    };

    const auditInput = (
      revisionId: string
    ): Parameters<typeof buildDetailedAuditReport>[1]["auditInput"] => ({
      auditReportId: `AUD-${publicRecord.caseId}-${revisionId}`,
      revisionId,
      birthRecord: publicRecord,
      timeEvidence: evidence,
      chartSet: charts,
      versionEvidence: deriveVersionEvidence(charts, evidence),
      workflowStatus,
      manualDecision: (overrides.manualDecision ?? noManualDecision()) as never,
      provenanceFlags,
      privateMetadataPresence: {
        providedTimeSourceNote: fullRecord.providedTime.sourceNote !== undefined
      },
      precisionCoverage: coverage as never,
      artifactManifest: overrides.artifactManifest ?? { artifacts: [] }
    });
    const context = CalculationContextV2Schema.parse({
      schemaVersion: "2.0.0",
      targetYears: charts.targetYears,
      timeInputBasis: publicRecord.providedTime.basis,
      provenanceFlags,
      precisionCoverage: coverage
    });
    let baziDetail: BaziDetailV1;
    try {
      baziDetail = this.baziDetailBuilder({
        publicBirthRecord: publicRecord,
        timeEvidence: evidence,
        baseChartSet: charts
      });
    } catch (error) {
      if (!(error instanceof BaziDetailGenerationError)) throw error;
      if (expectedExistingCaseId !== undefined) {
        throw new WorkbenchError(
          "BAZI_DETAIL_GENERATION_FAILED",
          "八字详盘暂时没有生成",
          422
        );
      }
      try {
        const fallback = await this.store.createRevisionFromFactory(
          publicRecord.caseId,
          (revisionId): RevisionArtifacts => {
            const audit = buildAuditReport(auditInput(revisionId));
            const identity = deriveApprovedRevisionIdentity(audit, AUDIT_CONTRACT_VERSION);
            const retryContext = CalculationContextV2FallbackSchema.parse({
              ...context,
              baziDetailGenerationStatus: "retryable_failure"
            });
            return {
              input: publicRecord,
              timeEvidence: evidence,
              charts,
              audit,
              auditMarkdown: renderAuditMarkdown(publicRecord, audit),
              reportReferenceMarkdown: renderReportReferenceMarkdown(publicRecord, audit),
              workflowStatus,
              auditContractVersion: AUDIT_CONTRACT_VERSION,
              rules: { ...identity.rules },
              dependencies: { ...identity.dependencies },
              calculationContext: retryContext,
              ...(Object.keys(privateContext).length === 0 ? {} : { privateContext })
            };
          },
          { expectedLineage: "empty" }
        );
        return {
          revision: publicRevision(fallback),
          snapshot: await this.decorateResultSnapshot(
            await this.store.readRevision(fallback.caseId, fallback.revisionId),
            supportedTargetYears
          )
        };
      } catch (fallbackError) {
        if (fallbackError instanceof CaseStoreError && fallbackError.code === "EXPECTED_EMPTY_LINEAGE_CHANGED") {
          throw new WorkbenchError(
            "BAZI_DETAIL_FALLBACK_LINEAGE_CHANGED",
            "案例已有成功结果，本次未写入基础回退",
            409
          );
        }
        throw fallbackError;
      }
    }

    const createV4 = async () => this.store.createRevisionFromFactory(
      publicRecord.caseId,
      (revisionId): RevisionArtifacts => {
        const audit = buildDetailedAuditReport(AUDIT_CONTRACT_VERSION_V4, {
          auditInput: auditInput(revisionId),
          baziDetail
        });
        const identity = deriveApprovedRevisionIdentity(audit, AUDIT_CONTRACT_VERSION_V4);
        return {
          input: publicRecord,
          timeEvidence: evidence,
          charts,
          baziDetail,
          audit,
          auditMarkdown: renderAuditMarkdown(publicRecord, audit, AUDIT_CONTRACT_VERSION_V4),
          reportReferenceMarkdown: renderReportReferenceMarkdown(publicRecord, audit, AUDIT_CONTRACT_VERSION_V4),
          workflowStatus,
          auditContractVersion: AUDIT_CONTRACT_VERSION_V4,
          rules: { ...identity.rules },
          dependencies: { ...identity.dependencies },
          calculationContext: context,
          ...(Object.keys(privateContext).length === 0 ? {} : { privateContext })
        };
      },
      expectedExistingCaseId === undefined ? { expectedLineage: "empty" } : undefined
    );
    let stored;
    try {
      stored = await createV4();
    } catch (error) {
      if (
        expectedExistingCaseId === undefined
        && error instanceof CaseStoreError
        && error.code === "EXPECTED_EMPTY_LINEAGE_CHANGED"
      ) {
        throw new WorkbenchError("CASE_EXISTS", "案例已存在；请建立新修订", 409);
      }
      throw error;
    }
    return {
      revision: publicRevision(stored),
      snapshot: await this.decorateResultSnapshot(
        await this.store.readRevision(stored.caseId, stored.revisionId),
        supportedTargetYears
      )
    };
  }

  private async createHistoricalV1Revision(
    request: CalculationRevisionIngressRequest,
    expectedExistingCaseId: string | undefined,
    overrides: {
      workflowStatus?: WorkflowStatus;
      manualDecision?: Record<string, unknown>;
      sourceImport?: LegacySourceRecord;
      artifactManifest?: { artifacts: Array<{ artifactId: string; sha256: string }> };
      precisionCoverage?: z.infer<typeof CalculationContextSchema>["precisionCoverage"];
    } = {}
  ) {
    const record = BirthRecordV1Schema.parse(request.birthRecord);
    if (expectedExistingCaseId !== undefined && expectedExistingCaseId !== record.caseId) {
      throw new WorkbenchError("CASE_ID_MISMATCH", "导入或修订的案例编号不一致");
    }
    const unknownBirthplaceClassification = classifyUnknownBirthplaceBasis(record);
    const attestation = request.unknownBirthplaceAttestation === undefined
      ? undefined
      : UnknownBirthplaceAttestationV1Schema.safeParse(request.unknownBirthplaceAttestation);
    if (unknownBirthplaceClassification === "invalid_basis") {
      const details = unknownBirthplaceBasisIssues(record)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("；");
      throw new WorkbenchError(
        "UNKNOWN_BIRTHPLACE_BASIS_INVALID",
        `出生地未知暂算组合不完整：${details}`,
        422
      );
    }
    if (unknownBirthplaceClassification === "valid_basis" && request.unknownBirthplaceAttestation === undefined) {
      throw new WorkbenchError(
        "UNKNOWN_BIRTHPLACE_ATTESTATION_REQUIRED",
        "出生地未知暂算必须由本地操作者确认锁定提示",
        422
      );
    }
    if (unknownBirthplaceClassification === "valid_basis" && attestation?.success === false) {
      throw new WorkbenchError(
        "UNKNOWN_BIRTHPLACE_ATTESTATION_INVALID",
        "出生地未知暂算确认必须精确匹配锁定本地操作者声明",
        422
      );
    }
    if (unknownBirthplaceClassification === "not_unknown" && request.unknownBirthplaceAttestation !== undefined) {
      throw new WorkbenchError(
        "UNKNOWN_BIRTHPLACE_ATTESTATION_UNEXPECTED",
        "真实地点记录不得携带出生地未知暂算确认",
        422
      );
    }
    const sourceImport = overrides.sourceImport ?? await this.resolveLegacySource(request.legacySource);
    const evidence = normalizeBirthTime(record);
    const charts = calculateCandidateCharts(record, evidence, { targetYears: request.targetYears });
    const provenanceFlags = deriveProvenanceFlags(record, request.provenanceFlags);
    const coverage = overrides.precisionCoverage ?? precisionCoverage(
      record,
      evidence.candidates.map((candidate) => candidate.id)
    );
    const workflowStatus = overrides.workflowStatus ?? request.workflowStatus;

    const stored = await this.store.createRevisionFromFactory(record.caseId, (revisionId): RevisionArtifacts => {
      const audit = buildAuditReport({
        auditReportId: `AUD-${record.caseId}-${revisionId}`,
        revisionId,
        birthRecord: record,
        timeEvidence: evidence,
        chartSet: charts,
        versionEvidence: deriveVersionEvidence(charts, evidence),
        workflowStatus,
        manualDecision: overrides.manualDecision ?? noManualDecision(),
        provenanceFlags,
        precisionCoverage: coverage,
        artifactManifest: overrides.artifactManifest ?? { artifacts: [] }
      });
      const identity = deriveApprovedRevisionIdentity(audit);
      const context = {
        schemaVersion: "1.0.0" as const,
        targetYears: charts.targetYears,
        provenanceFlags,
        ...(attestation?.success !== true
          ? {}
          : { unknownBirthplaceAttestation: attestation.data }),
        precisionCoverage: coverage
      };
      return {
        input: record,
        timeEvidence: evidence,
        charts,
        audit,
        auditMarkdown: renderAuditMarkdown(record, audit),
        reportReferenceMarkdown: renderReportReferenceMarkdown(record, audit),
        workflowStatus,
        auditContractVersion: AUDIT_CONTRACT_VERSION_V2,
        rules: { ...identity.rules },
        dependencies: { ...identity.dependencies },
        sourceImport,
        calculationContext: context
      };
    });
    return {
      revision: publicRevision(stored),
      snapshot: await this.decorateResultSnapshot(
        await this.store.readRevision(stored.caseId, stored.revisionId)
      )
    };
  }

  private async resolveLegacySource(
    link: CalculationRevisionRequest["legacySource"]
  ): Promise<LegacySourceRecord | undefined> {
    if (link === undefined) return undefined;
    const source = await this.store.inspectLegacySource(link.sourcePath);
    if (source.sha256 !== link.expectedSha256) {
      throw new WorkbenchError("LEGACY_SOURCE_CHANGED", "旧案来源文件指纹已变化，请重新检查", 409);
    }
    return source;
  }
}

export function isWorkbenchError(error: unknown): error is WorkbenchError | CaseStoreError {
  return error instanceof WorkbenchError || error instanceof CaseStoreError;
}
