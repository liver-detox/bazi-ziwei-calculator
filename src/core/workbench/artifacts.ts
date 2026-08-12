import type { BirthRecordV1 } from "../../shared/contracts.js";
import { PROVIDED_TIME_PRESENTATION } from "../../shared/provided-time-presentation.js";
import { locationRequiresClockConventionConfirmation } from "../../shared/clock-convention.js";
import { classifyUnknownBirthplaceBasis } from "../../shared/unknown-birthplace.js";
import {
  AUDIT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION_V4,
  AuditReportV1Schema,
  VersionEvidenceV2Schema,
  VersionEvidenceV3Schema,
  assessAuditVersionEvidence,
  assessAuditVersionEvidenceV3,
  isV4ProvidedTimeAuditBoundaryConsistent,
  parseAuditReportForContract,
  type AuditContractVersion,
  type AuditReportV1,
  type VersionedAuditReport
} from "../audit/index.js";
import { CURRENT_APPROVED_REVISION_IDENTITY } from "./revision-version-identity.js";

type MarkdownBirthRecord = Pick<BirthRecordV1, "caseId" | "alias">;

export const WORKBENCH_RULE_VERSIONS = CURRENT_APPROVED_REVISION_IDENTITY.rules;

export const WORKBENCH_DEPENDENCY_VERSIONS = CURRENT_APPROVED_REVISION_IDENTITY.dependencies;

function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function deriveProvenanceFlags(
  record: BirthRecordV1,
  explicitFlags: readonly string[] = []
): string[] {
  const flags = new Set(explicitFlags);
  if (record.location.clockConvention === "unknown") flags.add("clock_convention_unresolved");
  if (
    locationRequiresClockConventionConfirmation(record.location)
    && record.location.clockConvention !== "beijing"
    && record.location.clockConvention !== "xinjiang"
  ) {
    flags.add("xinjiang_clock_convention_unresolved");
  }
  if (record.location.coordinateSource === "representative_city") {
    flags.add("representative_coordinate");
  }
  if (classifyUnknownBirthplaceBasis(record) === "valid_basis") {
    flags.add("location_coordinate_unknown");
  }
  return [...flags].sort(compareCodePoints);
}

function markdownText(value: unknown): string {
  const htmlEntities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  };
  return String(value)
    .replace(/[\r\n|]+/gu, " ")
    .trim()
    .replace(/[&<>"']/gu, (character) => htmlEntities[character]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeWorkflowStatus(value: unknown): AuditReportV1["workflowStatus"] {
  return value === "draft" || value === "review" || value === "verified" || value === "void"
    ? value
    : "draft";
}

function safeString(value: unknown, fallback = "未记录"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function safeFingerprintValue(value: unknown): string {
  const candidate = typeof value === "string"
    ? value
    : isObject(value) && typeof value.value === "string"
      ? value.value
      : "";
  const normalized = candidate.replace(/^sha256:/u, "");
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : "未记录";
}

function renderedFingerprint(value: string): string {
  return value === "未记录" ? value : `sha256:${value.replace(/^sha256:/u, "")}`;
}

interface SafeFinding {
  code: string;
  severity: string;
  levelImpact: string;
  summary: string;
  candidateIds: string[];
}

function safeFindings(value: unknown): SafeFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): SafeFinding[] => {
    if (!isObject(entry)) return [];
    return [{
      code: safeString(entry.code),
      severity: safeString(entry.severity),
      levelImpact: safeString(entry.levelImpact),
      summary: safeString(entry.summary),
      candidateIds: Array.isArray(entry.candidateIds)
        ? entry.candidateIds.filter((candidateId): candidateId is string => typeof candidateId === "string")
        : []
    }];
  });
}

function safeAuditPresentation(report: VersionedAuditReport, auditContractVersion: AuditContractVersion): {
  auditLevel: AuditReportV1["auditLevel"];
  allowedAnalysisModes: AuditReportV1["allowedAnalysisModes"];
  versionEvidenceUntrusted: boolean;
  workflowStatus: AuditReportV1["workflowStatus"];
  revisionId: string;
  rulesetVersion: string;
  ruleIdentity: string | null;
  findings: SafeFinding[];
  contentFingerprint: string;
  timeBoundaryStatement: string | null;
  provenanceFlags: string[];
} {
  let parsed: VersionedAuditReport | null = null;
  try {
    parsed = parseAuditReportForContract(auditContractVersion, report);
  } catch {
    parsed = null;
  }
  const raw: Record<string, unknown> = isObject(report) ? report : {};
  const evidence = auditContractVersion === AUDIT_CONTRACT_VERSION_V4
    ? assessAuditVersionEvidenceV3(raw.engineVersions)
    : assessAuditVersionEvidence(raw.engineVersions);
  if (parsed !== null && evidence.approved) {
    const providedEvidence = auditContractVersion === AUDIT_CONTRACT_VERSION_V4
      ? VersionEvidenceV3Schema.safeParse(parsed.engineVersions)
      : VersionEvidenceV2Schema.safeParse(parsed.engineVersions);
    const boundary = parsed.timeInputBoundary;
    const boundaryPresentation = boundary === undefined ? null : PROVIDED_TIME_PRESENTATION[boundary.basis];
    const boundaryMatches = auditContractVersion === AUDIT_CONTRACT_VERSION_V4
      ? providedEvidence.success
        && boundary !== undefined
        && isV4ProvidedTimeAuditBoundaryConsistent({
          engineVersions: providedEvidence.data,
          timeInputBoundary: boundary,
          provenanceFlags: parsed.provenanceFlags
        })
      : providedEvidence.success
        && boundary !== undefined
        && providedEvidence.data.timeInputBasis === boundary.basis
        && boundaryPresentation?.assertionCode === boundary.assertionCode;
    const detailedEvidence = auditContractVersion === AUDIT_CONTRACT_VERSION_V4
      ? VersionEvidenceV3Schema.safeParse(parsed.engineVersions)
      : null;
    return {
      auditLevel: parsed.auditLevel,
      allowedAnalysisModes: parsed.allowedAnalysisModes,
      versionEvidenceUntrusted: false,
      workflowStatus: parsed.workflowStatus,
      revisionId: parsed.revisionId,
      rulesetVersion: parsed.rulesetVersion,
      ruleIdentity: detailedEvidence?.success === true
        ? [
            detailedEvidence.data.auditRuleset,
            detailedEvidence.data.timeRuleset,
            detailedEvidence.data.baziRuleset,
            detailedEvidence.data.baziDetailRuleset,
            detailedEvidence.data.ziweiRuleset
          ].join(" / ")
        : null,
      findings: safeFindings(parsed.findings),
      contentFingerprint: parsed.contentFingerprint.value,
      timeBoundaryStatement: boundaryMatches && boundaryPresentation !== null
        ? boundaryPresentation.statement
        : null,
      provenanceFlags: parsed.provenanceFlags === undefined ? [] : [...parsed.provenanceFlags]
    };
  }
  const workflowStatus = safeWorkflowStatus(raw.workflowStatus);
  return {
    auditLevel: "D",
    allowedAnalysisModes: workflowStatus === "void" ? [] : ["data_diagnosis"],
    versionEvidenceUntrusted: true,
    workflowStatus,
    revisionId: auditContractVersion === AUDIT_CONTRACT_VERSION_V4 ? "未记录" : safeString(raw.revisionId),
    rulesetVersion: auditContractVersion === AUDIT_CONTRACT_VERSION_V4 ? "未记录" : safeString(raw.rulesetVersion),
    ruleIdentity: null,
    findings: auditContractVersion === AUDIT_CONTRACT_VERSION_V4 ? [] : safeFindings(raw.findings),
    contentFingerprint: safeFingerprintValue(raw.contentFingerprint),
    timeBoundaryStatement: null,
    provenanceFlags: []
  };
}

export function renderAuditMarkdown(
  record: MarkdownBirthRecord,
  report: VersionedAuditReport,
  auditContractVersion: AuditContractVersion = AUDIT_CONTRACT_VERSION
): string {
  const presentation = safeAuditPresentation(report, auditContractVersion);
  const workflowNotice = presentation.versionEvidenceUntrusted
    ? "版本证据缺失或不可信；安全降级为 D 级，仅限资料诊断，禁止作为正式引用。"
    : presentation.workflowStatus === "verified"
    ? "已核验；人工核验不会改变原始 A–D 证据等级。"
    : presentation.workflowStatus === "void"
      ? "已作废；禁止用于任何下游分析。"
      : "仅供内部复核，不得作为正式报告输入。";
  const findingRows = presentation.findings.length === 0
    ? "| — | info | A | 无检查项 | — |"
    : presentation.findings.map((finding) => (
      `| ${markdownText(finding.code)} | ${markdownText(finding.severity)} | ${markdownText(finding.levelImpact)} | ${markdownText(finding.summary)} | ${markdownText(finding.candidateIds.join("、") || "—")} |`
    )).join("\n");

  return [
    "# 赛博大师·八字与紫微排盘计算器审计底稿",
    "",
    `> ${workflowNotice}`,
    "",
    `- 案例：${markdownText(record.caseId)} / ${markdownText(record.alias)}`,
    `- 修订：${markdownText(presentation.revisionId)}`,
    `- 审计等级：${presentation.auditLevel}`,
    `- 流程状态：${presentation.workflowStatus}`,
    `- 规则版本：${markdownText(presentation.rulesetVersion)}`,
    ...(presentation.ruleIdentity === null ? [] : [`- 规则身份：${markdownText(presentation.ruleIdentity)}`]),
    `- 版本证据：${presentation.versionEvidenceUntrusted ? "缺失或不可信（安全降级）" : "已记录并通过当前基线核验"}`,
    `- 内容指纹：${renderedFingerprint(presentation.contentFingerprint)}`,
    ...(presentation.timeBoundaryStatement === null ? [] : [`- 时间输入边界：${presentation.timeBoundaryStatement}`]),
    ...(presentation.provenanceFlags.length === 0 ? [] : [`- 公开来源标记：${presentation.provenanceFlags.map(markdownText).join("、")}`]),
    "",
    "## 检查项",
    "",
    "| 代码 | 严重性 | 等级影响 | 说明 | 候选 |",
    "| --- | --- | --- | --- | --- |",
    findingRows,
    "",
    "## 允许的分析模式",
    "",
    presentation.allowedAnalysisModes.length === 0
      ? "无。"
      : presentation.allowedAnalysisModes.map((mode) => `- ${mode}`).join("\n"),
    ""
  ].join("\n");
}

export function renderReportReferenceMarkdown(
  record: MarkdownBirthRecord,
  report: VersionedAuditReport,
  auditContractVersion: AuditContractVersion = AUDIT_CONTRACT_VERSION
): string {
  const presentation = safeAuditPresentation(report, auditContractVersion);
  const status = presentation.versionEvidenceUntrusted
    ? "版本证据缺失或不可信；禁止作为正式引用，仅限资料诊断"
    : presentation.workflowStatus === "verified" ? "可按审计等级引用" : "仅内部待复核";
  return [
    presentation.versionEvidenceUntrusted ? "# 资料诊断摘要" : "# 正式报告引用摘要",
    "",
    presentation.versionEvidenceUntrusted
      ? `> ${status}。`
      : `> ${status}。引用时不得删除审计等级、修订号、规则版本或内容指纹。`,
    "",
    `- 案例编号：${markdownText(record.caseId)}`,
    `- 化名：${markdownText(record.alias)}`,
    `- 审计等级：${presentation.auditLevel}`,
    `- 修订号：${markdownText(presentation.revisionId)}`,
    `- 流程状态：${presentation.workflowStatus}`,
    `- 规则版本：${markdownText(presentation.rulesetVersion)}`,
    ...(presentation.ruleIdentity === null ? [] : [`- 规则身份：${markdownText(presentation.ruleIdentity)}`]),
    `- 内容指纹：${renderedFingerprint(presentation.contentFingerprint)}`,
    `- 版本证据：${presentation.versionEvidenceUntrusted ? "缺失或不可信（安全降级）" : "已记录并通过当前基线核验"}`,
    `- 可用模式：${presentation.allowedAnalysisModes.join("、") || "无"}`,
    ...(presentation.timeBoundaryStatement === null ? [] : [`- 时间输入边界：${presentation.timeBoundaryStatement}`]),
    ...(presentation.provenanceFlags.length === 0 ? [] : [`- 公开来源标记：${presentation.provenanceFlags.map(markdownText).join("、")}`]),
    ""
  ].join("\n");
}

function legacyField(value: Record<string, unknown>, field: string, fallback: string): string {
  const selected = value[field];
  return typeof selected === "string" && selected.trim().length > 0 ? markdownText(selected) : fallback;
}

export function renderLegacyAuditMarkdown(
  record: Record<string, unknown>,
  report: Record<string, unknown>
): string {
  return [
    "# 旧版审计报告（只读兼容）",
    "",
    "> 版本证据未按当前契约验证；禁止作为正式引用，仅限资料诊断。源文件保持不变。",
    "",
    `- 案例：${legacyField(record, "caseId", "未记录")} / ${legacyField(record, "alias", "未记录")}`,
    `- 修订：${legacyField(report, "revisionId", "未记录")}`,
    `- 源报告自述等级：${legacyField(report, "auditLevel", "未记录")}（未按当前契约验证）`,
    "- 当前安全等级：D",
    "- 审计证据状态：legacy_unvalidated",
    "",
    "## 允许的分析模式",
    "",
    "- data_diagnosis",
    ""
  ].join("\n");
}

export function renderLegacyReportReferenceMarkdown(
  record: Record<string, unknown>,
  report: Record<string, unknown>
): string {
  return [
    "# 旧版审计报告引用摘要（只读兼容）",
    "",
    "> 版本证据未按当前契约验证；禁止作为正式引用，仅限资料诊断。",
    "",
    `- 案例编号：${legacyField(record, "caseId", "未记录")}`,
    `- 化名：${legacyField(record, "alias", "未记录")}`,
    `- 修订号：${legacyField(report, "revisionId", "未记录")}`,
    "- 审计证据状态：legacy_unvalidated",
    "- 当前安全等级：D",
    "- 可用模式：data_diagnosis",
    ""
  ].join("\n");
}
