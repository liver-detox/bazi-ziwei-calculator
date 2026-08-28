import { Check, CircleAlert, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { TimeEvidenceAny } from "../shared/contracts.js";
import { PROVIDED_TIME_PRESENTATION } from "../shared/provided-time-presentation.js";
import type { ExportActionResult } from "./export-download.js";

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
  return <NativeDialog className="result-drawer verification-drawer" label="结果与导出" onClose={onClose} open={open} returnFocus={returnFocus}>
    <div className="drawer-body verification-body">
      <section><h2>时间依据</h2>{evidence}</section>
      <section><h2>选择结果</h2>{audit}</section>
      <section><h2>导出</h2>{exportPanel}</section>
      <details className="advanced-technical"><summary>高级技术信息</summary><div>{technical ?? <p>版本与指纹仅用于本地复核。</p>}</div></details>
    </div>
  </NativeDialog>;
}

const BASIS_LABELS: Record<string, string> = { civil_iana: "民用时 · IANA", civil_standard: "标准时候选", gap_before: "跳时前纠偏", gap_after: "跳时后纠偏", apparent_solar: "真太阳时", apparent_solar_provided: PROVIDED_TIME_PRESENTATION.apparent_solar_provided.label, civil_clock_provided: PROVIDED_TIME_PRESENTATION.civil_clock_provided.label };
const CALENDAR_BASIS_LABELS: Record<string, string> = { solar: "公历", lunar_regular: "农历普通月", lunar_leap: "农历闰月" };
export function TimeEvidencePanel({ evidence }: { evidence: TimeEvidenceAny }) {
  const provided = evidence.schemaVersion === "2.0.0" ? PROVIDED_TIME_PRESENTATION[evidence.originalTimeBasis] : undefined;
  return <div className="drawer-evidence">
    <div className="evidence-summary">{evidence.schemaVersion === "2.0.0" ? <><div><span>输入口径</span><strong>{provided?.label}</strong></div><div><span>给定时间</span><strong>{evidence.originalLocalTime}</strong></div><div><span>历法</span><strong>{evidence.originalCalendar.type === "solar" ? "公历" : "农历"}</strong></div><div><span>系统处理</span><strong>不再校正</strong></div></> : <><div><span>时区</span><strong>{evidence.timeZone}</strong></div><div><span>经度</span><strong>{evidence.longitude.toFixed(5)}°</strong></div><div><span>标准偏移来源</span><strong>{evidence.standardOffsetSource}</strong></div><div><span>时区数据</span><strong>{evidence.timezoneEngine.tzdbVersion}</strong></div></>}</div>
    {provided && <p className="time-boundary-statement">{provided.statement}</p>}
    <div className="candidate-grid">{evidence.candidates.map((candidate, index) => <article className={candidate.preferred ? "candidate-card preferred" : "candidate-card"} key={candidate.id}><div className="candidate-card-header"><div><strong className="candidate-number">候选 {index + 1}</strong><span>{BASIS_LABELS[candidate.basis] ?? candidate.basis}{candidate.calendarBasis ? ` · ${CALENDAR_BASIS_LABELS[candidate.calendarBasis] ?? candidate.calendarBasis}` : ""}</span></div>{candidate.preferred && <em>主候选</em>}</div><strong className="candidate-time">{candidate.localDateTime.replace("T", " ")}</strong><div className="candidate-meta"><span>{candidate.earthlyBranch.name}时</span>{"offset" in candidate && <span>UTC {candidate.offset}</span>}<span>{candidate.dayBoundary === "forward" ? "次日换日" : "当日换日"}</span></div>{"trueSolarCorrection" in candidate && candidate.trueSolarCorrection && <dl className="correction-list"><div><dt>经度修正</dt><dd>{candidate.trueSolarCorrection.longitudeCorrectionMinutes.toFixed(2)} 分</dd></div><div><dt>均时差</dt><dd>{candidate.trueSolarCorrection.equationOfTimeMinutes.toFixed(2)} 分</dd></div><div><dt>总修正</dt><dd>{candidate.trueSolarCorrection.roundedTotalCorrectionMinutes} 分</dd></div></dl>}</article>)}</div>
    {evidence.calendarResolutions.length > 0 && <div className="issue-list">{evidence.calendarResolutions.map((resolution) => resolution.status === "valid" ? <div className="success-note" key={resolution.id}><Check size={17} /> {CALENDAR_BASIS_LABELS[resolution.basis] ?? resolution.basis} → {resolution.solarDate} · {resolution.note}</div> : <article className="issue blocking" key={resolution.id}><CircleAlert size={16} /><div><strong>{CALENDAR_BASIS_LABELS[resolution.basis] ?? resolution.basis}转换无效</strong><p>{resolution.note}</p></div></article>)}</div>}
    <div className="issue-list">{evidence.issues.length === 0 ? <div className="success-note"><Check size={16} /> 当前没有时间口径警告</div> : evidence.issues.map((issue, index) => <article className={`issue ${issue.severity}`} key={`${issue.code}-${index}`}><CircleAlert size={16} /><p>{issue.message}</p></article>)}</div>
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

function visibleDecisionNote(rationale: string | null | undefined): string {
  if (!rationale) return "";
  if (rationale.startsWith("用户补充说明：")) return rationale.slice("用户补充说明：".length);
  if (rationale.startsWith("用户补充：")) return rationale.slice("用户补充：".length);
  if (/^用户已确认使用候选 \d+。$/u.test(rationale)) return "";
  return rationale;
}

export function drawerDecisionState(audit: Pick<DrawerAudit, "candidateIds" | "manualDecision">): { candidateId: string; rationale: string } {
  return {
    candidateId: audit.manualDecision?.selectedCandidateId ?? audit.candidateIds[0] ?? "",
    rationale: visibleDecisionNote(audit.manualDecision?.rationale)
  };
}

export function selectionDecisionPayload(candidateId: string, candidateIds: readonly string[], note: string): Record<string, unknown> {
  const candidateIndex = candidateIds.indexOf(candidateId);
  const rationale = note.trim() === ""
    ? candidateIndex >= 0 ? `用户已确认使用候选 ${candidateIndex + 1}。` : "用户已确认使用所选结果。"
    : `用户补充说明：${note.trim()}`;
  return { status: "selected", selectedCandidateId: candidateId, rationale, workflowStatus: "review" };
}

export function AuditPanel({ audit, candidateOrder, identity, open, onDecision, busy }: { audit: DrawerAudit; candidateOrder?: readonly string[]; identity: string; open: boolean; onDecision: (payload: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const orderedCandidateIds = candidateOrder?.filter((id) => audit.candidateIds.includes(id));
  const candidateIds = orderedCandidateIds?.length === audit.candidateIds.length
    ? orderedCandidateIds
    : audit.candidateIds;
  const initial = drawerDecisionState({ candidateIds, manualDecision: audit.manualDecision });
  const [candidateId, setCandidateId] = useState(initial.candidateId);
  const [rationale, setRationale] = useState(initial.rationale);
  useEffect(() => { const next = drawerDecisionState({ candidateIds, manualDecision: audit.manualDecision }); setCandidateId(next.candidateId); setRationale(next.rationale); }, [identity, open]);
  const visibleCandidates = (ids: readonly string[]) => ids.map((id) => {
    const index = candidateIds.indexOf(id);
    return index < 0 ? "未识别候选" : `候选 ${index + 1}`;
  }).join(" · ");
  const needsChoice = candidateIds.length > 1;
  return <div className="drawer-audit">
    <div className="finding-list">{audit.findings.map((finding, index) => <article className={finding.severity} key={`${finding.code}-${index}`}><p>{finding.summary}</p>{finding.candidateIds?.length ? <small>{visibleCandidates(finding.candidateIds)}</small> : null}</article>)}</div>
    {needsChoice ? <div className="decision-box"><div><h3>选择要使用的结果</h3><p>有多个可能结果，请选择一个。</p></div><label>选择结果<select onChange={(event) => setCandidateId(event.target.value)} value={candidateId}>{candidateIds.map((id, index) => <option key={id} value={id}>候选 {index + 1}</option>)}</select></label><label>补充说明（可选）<input onChange={(event) => setRationale(event.target.value)} placeholder="例如：出生记录更支持候选 1" value={rationale} /></label><div className="decision-actions"><button className="button primary" disabled={busy || !candidateId} onClick={() => void onDecision(selectionDecisionPayload(candidateId, candidateIds, rationale))} type="button"><Check size={16} /> 确认选择</button></div></div> : <p className="result-inline-empty">当前只有一个结果，无需选择。</p>}
  </div>;
}

export interface ExportPanelProps {
  busy: boolean;
  shareAvailable: boolean;
  status: "" | ExportActionResult;
  textError?: string;
  textPreparing?: boolean;
  textReady?: boolean;
  onRetryText?: () => void;
  onCopy: () => Promise<void>;
  onDownloadText: () => Promise<void>;
  onShare: () => Promise<void>;
  onPrint: () => Promise<void>;
  onDownloadJson: () => Promise<void>;
}

function exportStatusText(status: ExportPanelProps["status"]): string {
  const labels: Record<ExportActionResult, string> = {
    copied: "复制成功",
    download_started: "浏览器已开始下载",
    shared: "分享完成",
    share_unavailable: "分享不可用",
    share_cancelled: "取消分享",
    print_started: "已请求系统打印"
  };
  return status === "" ? "" : labels[status];
}

export function ExportPanel({ busy, shareAvailable, status, textError = "", textPreparing = false, textReady = true, onRetryText, onCopy, onDownloadText, onShare, onPrint, onDownloadJson }: ExportPanelProps) {
  const statusText = exportStatusText(status);
  const textActionDisabled = busy || !textReady;
  return <div className="drawer-export">
    <p className="field-note">导出内容包含当前输入的姓名或代号及出生资料，请确认后再分享。</p>
    {textPreparing && <p aria-live="polite" className="field-note" role="status">正在准备文本导出……</p>}
    {textError && <div className="field-note" role="alert">AI 文本准备失败：{textError} {onRetryText && <button className="button ghost" disabled={busy || textPreparing} onClick={onRetryText} type="button">重试准备 AI 文本</button>}</div>}
    <section className="export-action-group"><h3>给大模型使用</h3><div className="export-actions">{shareAvailable && <button className="button primary" disabled={textActionDisabled} onClick={() => void onShare()} type="button">系统分享</button>}<button className={shareAvailable ? "button secondary" : "button primary"} disabled={textActionDisabled} onClick={() => void onCopy()} type="button">复制 AI 文本</button></div>{shareAvailable ? <p className="field-note">系统分享可能发送 TXT 文件或同一文本，复制可作为备选。</p> : <p className="field-note">当前浏览器不支持系统分享，请使用复制或下载 TXT。</p>}</section>
    <section className="export-action-group"><h3>阅读与保存</h3><div className="export-actions"><button className="button secondary" disabled={textActionDisabled} onClick={() => void onDownloadText()} type="button">下载 TXT</button><button className="button secondary" disabled={textActionDisabled} onClick={() => void onPrint()} type="button">打开打印</button></div><p className="field-note">浏览器/系统提供时可在打印窗口存为 PDF。</p></section>
    <section className="export-action-group"><h3>完整数据</h3><div className="export-actions"><button className="button secondary" disabled={busy} onClick={() => void onDownloadJson()} type="button">下载完整 JSON</button></div></section>
    {statusText && <p aria-live="polite" className="export-result" role="status"><Check size={16} /> {statusText}</p>}
  </div>;
}
