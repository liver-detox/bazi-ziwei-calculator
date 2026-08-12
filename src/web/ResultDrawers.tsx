import { Archive, Check, CircleAlert, Download, FolderLock, LoaderCircle, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { TimeEvidenceAny } from "../shared/contracts.js";
import { PROVIDED_TIME_PRESENTATION } from "../shared/provided-time-presentation.js";
import type { ExportDestination, ExportSaveResult } from "./export-download.js";

export function syncNativeDialog(dialog: HTMLDialogElement, open: boolean): void {
  if (open && !dialog.open) dialog.showModal();
  if (!open && dialog.open) dialog.close();
}

export function closeNativeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

export function handleNativeDialogClose(onClose: () => void, returnFocus?: HTMLElement | null): void {
  returnFocus?.focus();
  onClose();
}

export function connectNativeDialogLifecycle(
  dialog: HTMLDialogElement,
  options: { open: boolean; onClose: () => void; returnFocus?: HTMLElement | null }
): () => void {
  const onNativeClose = () => handleNativeDialogClose(options.onClose, options.returnFocus);
  dialog.addEventListener("close", onNativeClose);
  syncNativeDialog(dialog, options.open);
  return () => dialog.removeEventListener("close", onNativeClose);
}

export interface ResultCaseSummary {
  caseId: string;
  alias: string;
  latestRevisionId: string;
  workflowStatus: string;
  auditLevel: "A" | "B" | "C" | "D";
  contentFingerprint: string;
}

interface NativeDialogProps {
  open?: boolean;
  label: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  children: ReactNode;
  className?: string;
}

function NativeDialog({ open = true, label, onClose, returnFocus, children, className }: NativeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    return dialog === null ? undefined : connectNativeDialogLifecycle(dialog, { open, onClose, returnFocus });
  }, [onClose, open, returnFocus]);
  const close = () => {
    if (dialogRef.current) closeNativeDialog(dialogRef.current);
  };
  return (
    <dialog aria-label={label} className={className} ref={dialogRef}>
      <div className="drawer-dialog-bar"><strong>{label}</strong><button aria-label={`关闭${label}`} className="icon-button" onClick={close} type="button"><X size={18} /></button></div>
      {children}
    </dialog>
  );
}

export interface CaseDrawerProps {
  open?: boolean;
  cases: readonly ResultCaseSummary[];
  currentCaseId: string;
  onSelect: (item: ResultCaseSummary) => void;
  onCreate: () => void;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}

export function CaseDrawer({ open, cases, currentCaseId, onSelect, onCreate, onClose, returnFocus }: CaseDrawerProps) {
  const [query, setQuery] = useState("");
  const visible = cases.filter((item) => `${item.caseId} ${item.alias}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  return <NativeDialog className="result-drawer case-drawer" label="当前案例" onClose={onClose} open={open} returnFocus={returnFocus}>
    <div className="drawer-body">
      <p>当前案例：{cases.find((item) => item.caseId === currentCaseId)?.alias ?? "未选择"}</p>
      <label className="search-box"><Search size={16} /><span className="sr-only">搜索案例</span><input aria-label="搜索案例" onChange={(event) => setQuery(event.target.value)} placeholder="搜索编号或化名" value={query} /></label>
      <div className="drawer-case-list">
        {visible.map((item) => <button aria-current={item.caseId === currentCaseId ? "true" : undefined} className={item.caseId === currentCaseId ? "selected" : undefined} key={item.caseId} onClick={() => onSelect(item)} type="button"><strong>{item.alias}</strong><span>{item.caseId} · {item.latestRevisionId}</span></button>)}
        {visible.length === 0 && <p className="result-inline-empty">没有匹配的案例。</p>}
      </div>
    </div>
    <div className="drawer-fixed-action"><button className="button primary" onClick={onCreate} type="button">新建排盘</button></div>
  </NativeDialog>;
}

export interface VerificationDrawerProps {
  open?: boolean;
  evidence: ReactNode;
  audit: ReactNode;
  exportPanel: ReactNode;
  technical?: ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}

export function VerificationDrawer({ open, evidence, audit, exportPanel, technical, onClose, returnFocus }: VerificationDrawerProps) {
  return <NativeDialog className="result-drawer verification-drawer" label="核验与导出" onClose={onClose} open={open} returnFocus={returnFocus}>
    <div className="drawer-body verification-body">
      <section><h2>时间依据</h2>{evidence}</section>
      <section><h2>差异与人工确认</h2>{audit}</section>
      <section><h2>导出</h2>{exportPanel}</section>
      <details className="advanced-technical"><summary>高级技术信息</summary><div>{technical ?? <p>版本与指纹仅用于本地复核。</p>}</div></details>
    </div>
  </NativeDialog>;
}

const BASIS_LABELS: Record<string, string> = { civil_iana: "民用时 · IANA", civil_standard: "标准时候选", gap_before: "跳时前纠偏", gap_after: "跳时后纠偏", apparent_solar: "真太阳时", apparent_solar_provided: PROVIDED_TIME_PRESENTATION.apparent_solar_provided.label, civil_clock_provided: PROVIDED_TIME_PRESENTATION.civil_clock_provided.label };
const CALENDAR_BASIS_LABELS: Record<string, string> = { solar: "公历", lunar_regular: "农历普通月", lunar_leap: "农历闰月" };
const ANALYSIS_LABELS: Record<string, string> = { full_dual: "完整双轨", provisional_dual: "暂准双轨", single_track: "稳定单轨", data_diagnosis: "资料诊断" };
const WORKFLOW_LABELS: Record<string, string> = { draft: "待完善", review: "待核验", verified: "已核验", void: "已作废" };

export function TimeEvidencePanel({ evidence }: { evidence: TimeEvidenceAny }) {
  const provided = evidence.schemaVersion === "2.0.0" ? PROVIDED_TIME_PRESENTATION[evidence.originalTimeBasis] : undefined;
  return <div className="drawer-evidence">
    <div className="evidence-summary">{evidence.schemaVersion === "2.0.0" ? <><div><span>输入口径</span><strong>{provided?.label}</strong></div><div><span>给定时间</span><strong>{evidence.originalLocalTime}</strong></div><div><span>历法</span><strong>{evidence.originalCalendar.type === "solar" ? "公历" : "农历"}</strong></div><div><span>系统处理</span><strong>不再校正</strong></div></> : <><div><span>时区</span><strong>{evidence.timeZone}</strong></div><div><span>经度</span><strong>{evidence.longitude.toFixed(5)}°</strong></div><div><span>标准偏移来源</span><strong>{evidence.standardOffsetSource}</strong></div><div><span>时区数据</span><strong>{evidence.timezoneEngine.tzdbVersion}</strong></div></>}</div>
    {provided && <p className="time-boundary-statement">{provided.statement}</p>}
    <div className="candidate-grid">{evidence.candidates.map((candidate, index) => <article className={candidate.preferred ? "candidate-card preferred" : "candidate-card"} key={candidate.id}><div className="candidate-card-header"><div><strong className="candidate-number">候选 {index + 1}</strong><span>{BASIS_LABELS[candidate.basis] ?? candidate.basis}{candidate.calendarBasis ? ` · ${CALENDAR_BASIS_LABELS[candidate.calendarBasis] ?? candidate.calendarBasis}` : ""}</span></div>{candidate.preferred && <em>主候选</em>}</div><strong className="candidate-time">{candidate.localDateTime.replace("T", " ")}</strong><div className="candidate-meta"><span>{candidate.earthlyBranch.name}时</span>{"offset" in candidate && <span>UTC {candidate.offset}</span>}<span>{candidate.dayBoundary === "forward" ? "次日换日" : "当日换日"}</span></div>{"trueSolarCorrection" in candidate && candidate.trueSolarCorrection && <dl className="correction-list"><div><dt>经度修正</dt><dd>{candidate.trueSolarCorrection.longitudeCorrectionMinutes.toFixed(2)} 分</dd></div><div><dt>均时差</dt><dd>{candidate.trueSolarCorrection.equationOfTimeMinutes.toFixed(2)} 分</dd></div><div><dt>总修正</dt><dd>{candidate.trueSolarCorrection.roundedTotalCorrectionMinutes} 分</dd></div></dl>}</article>)}</div>
    {evidence.calendarResolutions.length > 0 && <div className="issue-list">{evidence.calendarResolutions.map((resolution) => resolution.status === "valid" ? <div className="success-note" key={resolution.id}><Check size={17} /> {CALENDAR_BASIS_LABELS[resolution.basis] ?? resolution.basis} → {resolution.solarDate} · {resolution.note}</div> : <article className="issue blocking" key={resolution.id}><CircleAlert size={16} /><div><strong>{CALENDAR_BASIS_LABELS[resolution.basis] ?? resolution.basis}转换无效</strong><p>{resolution.note}</p></div></article>)}</div>}
    <div className="issue-list">{evidence.issues.length === 0 ? <div className="success-note"><Check size={16} /> 当前没有时间口径警告</div> : evidence.issues.map((issue, index) => <article className={`issue ${issue.severity}`} key={`${issue.code}-${index}`}><CircleAlert size={16} /><div><strong>{issue.code}</strong><p>{issue.message}</p></div></article>)}</div>
  </div>;
}

export interface DrawerAudit {
  auditLevel: string;
  workflowStatus: string;
  allowedAnalysisModes?: string[];
  findings: Array<{ code: string; severity: "info" | "warning" | "blocking"; summary: string; levelImpact?: string; candidateIds?: string[] }>;
  candidateIds: string[];
  manualDecision?: { selectedCandidateId: string | null; rationale: string | null };
}

export function drawerDecisionState(audit: Pick<DrawerAudit, "candidateIds" | "manualDecision">): { candidateId: string; rationale: string } {
  return { candidateId: audit.manualDecision?.selectedCandidateId ?? audit.candidateIds[0] ?? "", rationale: audit.manualDecision?.rationale ?? "" };
}

export function AuditPanel({ audit, identity, open, onDecision, busy }: { audit: DrawerAudit; identity: string; open: boolean; onDecision: (payload: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const initial = drawerDecisionState(audit);
  const [candidateId, setCandidateId] = useState(initial.candidateId);
  const [rationale, setRationale] = useState(initial.rationale);
  useEffect(() => { const next = drawerDecisionState(audit); setCandidateId(next.candidateId); setRationale(next.rationale); }, [identity, open]);
  const submit = (status: "selected" | "retained_all" | "deferred", workflowStatus: "review" | "verified") => void onDecision({ status, selectedCandidateId: status === "selected" ? candidateId : null, rationale, workflowStatus });
  const visibleCandidates = (ids: readonly string[]) => ids.map((id) => {
    const index = audit.candidateIds.indexOf(id);
    return index < 0 ? "未识别候选" : `候选 ${index + 1}`;
  }).join(" · ");
  return <div className="drawer-audit"><p>当前核验状态：{WORKFLOW_LABELS[audit.workflowStatus] ?? "待确认"}</p><div className="analysis-modes"><span>当前允许：</span>{(audit.allowedAnalysisModes ?? []).map((mode) => <em key={mode}>{ANALYSIS_LABELS[mode] ?? mode}</em>)}</div><div className="finding-list">{audit.findings.map((finding, index) => <article className={finding.severity} key={`${finding.code}-${index}`}><div><strong>{finding.code}</strong>{finding.levelImpact && <span>影响 {finding.levelImpact}</span>}</div><p>{finding.summary}</p>{finding.candidateIds?.length ? <small>{visibleCandidates(finding.candidateIds)}</small> : null}</article>)}</div><div className="decision-box"><div><h3>人工决定</h3><p>决定只记录操作口径，不删除原始候选和阻断原因。</p></div><label>工作主候选<select onChange={(event) => setCandidateId(event.target.value)} value={candidateId}>{audit.candidateIds.map((id, index) => <option key={id} value={id}>候选 {index + 1}</option>)}</select></label><label>采用理由<input onChange={(event) => setRationale(event.target.value)} placeholder="至少说明证据依据与保留风险" value={rationale} /></label><div className="decision-actions"><button className="button secondary" disabled={busy || rationale.trim().length < 8} onClick={() => submit("retained_all", "review")} type="button">保留全部</button><button className="button secondary" disabled={busy || rationale.trim().length < 8 || !candidateId} onClick={() => submit("selected", "review")} type="button">选为工作主盘</button><button className="button primary" disabled={busy || rationale.trim().length < 8} onClick={() => submit(candidateId ? "selected" : "deferred", "verified")} type="button"><ShieldCheck size={16} /> 保存为已核验新修订</button></div></div></div>;
}

export interface ExportPanelProps {
  identity: string;
  open: boolean;
  busy: boolean;
  status: "" | ExportSaveResult;
  onExport: (includePrivate: boolean, destination: ExportDestination) => Promise<void>;
}

export function requestEvidenceExport(
  onExport: ExportPanelProps["onExport"],
  includePrivate: boolean,
  destination: ExportDestination
): Promise<void> {
  return onExport(includePrivate, destination);
}

function exportStatusText(status: ExportPanelProps["status"]): string {
  if (status === "download_started") return "已交给浏览器下载";
  if (status === "saved") return "已保存到所选位置";
  if (status === "fallback_download") return "浏览器不支持直接选择位置，已改用默认下载";
  return "";
}

export function ExportPanel({ identity, open, onExport, busy, status }: ExportPanelProps) {
  const [includePrivate, setIncludePrivate] = useState(false);
  useEffect(() => { setIncludePrivate(false); }, [identity, open]);
  const statusText = exportStatusText(status);
  return <div className="drawer-export"><label className="check-row"><input checked={includePrivate} onChange={(event) => setIncludePrivate(event.target.checked)} type="checkbox" /> 显式包含私密身份文件（默认关闭）</label><p className="field-note"><FolderLock size={14} /> 默认导出不包含私密身份资料。</p><div className="export-actions"><button className="button primary" disabled={busy} onClick={() => void requestEvidenceExport(onExport, includePrivate, "downloads")} type="button">{busy ? <LoaderCircle className="spin" size={17} /> : <Archive size={17} />} 导出到下载文件夹</button><button className="button secondary" disabled={busy} onClick={() => void requestEvidenceExport(onExport, includePrivate, "choose")} type="button"><Download size={17} /> 选择保存位置…</button></div>{statusText && <p className="export-result"><Check size={16} /> {statusText}</p>}</div>;
}
