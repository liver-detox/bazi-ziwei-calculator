import { Check, CircleAlert, LoaderCircle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { BaziDetailV1 } from "../core/charts/bazi-detail-contract.js";
import type { DualTrackChartSetV1 } from "../core/charts/types.js";
import type { ResultCapabilities } from "../core/workbench/case-workbench.js";
import type { BirthRecordAny, TimeEvidenceAny } from "../shared/contracts.js";
import { ApiError, apiJsonDownload, apiRequest, providedTimeFieldErrors } from "./api.js";
import { ProvidedTimeForm } from "./ProvidedTimeForm.js";
import {
  AuditPanel,
  CaseDrawer,
  ExportPanel,
  TimeEvidencePanel,
  VerificationDrawer,
  type DrawerAudit,
  type ResultCaseSummary
} from "./ResultDrawers.js";
import { ResultsShell } from "./ResultsShell.js";
import { saveChartDocumentDownload, type ExportSaveResult } from "./export-download.js";
import { createResultsAppActions, drawerIdentity, sortedTargetYears, type ResultsAppActionState } from "./results-orchestration-model.js";
import {
  createResultSelection,
  selectionAfterTargetYearMutation,
  type ResultSelection,
  type TargetYearPage
} from "./results-model.js";
import {
  buildProvidedTimeRequest,
  emptyProvidedTimeForm,
  nextAvailableCaseId,
  type ProvidedTimeFormState
} from "./provided-time-form-model.js";

export interface RevisionSnapshot {
  input: BirthRecordAny;
  timeEvidence: TimeEvidenceAny;
  charts: DualTrackChartSetV1;
  audit: DrawerAudit & {
    auditLevel: "A" | "B" | "C" | "D";
    findings: Array<{ code: string; severity: "info" | "warning" | "blocking"; summary: string; candidateIds: string[] }>;
    blockingReasons?: Array<{ code: string; summary: string }>;
    manualDecision?: { status: string; selectedCandidateId: string | null; rationale: string | null };
    contentFingerprint?: { value: string } | string;
  };
  manifest: { revisionId: string; contentFingerprint: string };
  baziDetail: BaziDetailV1 | null;
  resultCapabilities: ResultCapabilities;
}

interface CreateCaseResponse { revision: { caseId: string; revisionId: string }; snapshot: RevisionSnapshot; }

function snapshotIdentity(snapshot: RevisionSnapshot): string {
  return drawerIdentity(snapshot.input.caseId, snapshot.manifest.revisionId);
}

export const resultsAppActions = createResultsAppActions<RevisionSnapshot, ResultSelection>({
  identityFor: snapshotIdentity,
  selectionFor: createResultSelection
});

export interface ResultsAppActionSetters<Snapshot, Selection> {
  setSnapshot: (snapshot: Snapshot | undefined) => void;
  setSelection: (selection: Selection | undefined) => void;
  setRetainedSnapshotRisk: (retained: boolean) => void;
  setShowForm: (showForm: boolean) => void;
  setRevisionCaseId: (caseId: string | undefined) => void;
}

export function applyResultsAppActionState<Snapshot, Selection>(
  state: ResultsAppActionState<Snapshot, Selection>,
  setters: ResultsAppActionSetters<Snapshot, Selection>
): void {
  setters.setSnapshot(state.snapshot);
  setters.setSelection(state.selection);
  setters.setRetainedSnapshotRisk(state.retainedSnapshotRisk);
  setters.setShowForm(state.showForm);
  setters.setRevisionCaseId(state.revisionCaseId);
}

export function formFromRevision(input: BirthRecordAny, targetYears: readonly number[]): ProvidedTimeFormState {
  const form = emptyProvidedTimeForm();
  if (input.schemaVersion === "2.0.0") return { ...form, alias: input.alias, gender: input.gender, calendarType: input.calendar.type, date: input.calendar.date, leapMonth: input.calendar.leapMonth, localTime: input.providedTime.localTime, timeBasis: input.providedTime.basis, precision: input.providedTime.precision, sourceType: input.providedTime.sourceType, lateZi: input.policy.lateZi, targetYears: targetYears.join(", ") };
  return { ...form, alias: input.alias, gender: input.gender, calendarType: input.calendar.type, date: input.calendar.date, leapMonth: input.calendar.leapMonth, localTime: input.birthTime.localTime, precision: input.birthTime.precision, sourceType: input.birthTime.sourceType, lateZi: input.policy.lateZi, targetYears: targetYears.join(", ") };
}

export function preferredCaseSummary(
  rows: readonly ResultCaseSummary[],
  preferCaseId?: string,
  selectedCaseId?: string
): ResultCaseSummary | undefined {
  const wanted = preferCaseId || selectedCaseId || rows[0]?.caseId;
  return rows.find((row) => row.caseId === wanted);
}

export function chartDocumentDownloadRequest(
  snapshot: Pick<RevisionSnapshot, "input" | "manifest">,
  selection: Pick<ResultSelection, "candidateId" | "selectedTargetYear">
): { path: string; options: RequestInit } {
  return {
    path: `/api/cases/${snapshot.input.caseId}/revisions/${snapshot.manifest.revisionId}/chart-document`,
    options: {
      method: "POST",
      body: JSON.stringify({
        candidateId: selection.candidateId,
        ...(selection.selectedTargetYear === null ? {} : { targetYear: selection.selectedTargetYear })
      })
    }
  };
}

function EmptyResults({ onCreate }: { onCreate: () => void }) {
  return <section className="result-page result-empty-state"><p className="eyebrow">双轨结果</p><h2>尚未开始排盘</h2><p>先录入一份出生资料，系统会生成可核验的八字与紫微结果。</p><button className="button primary" onClick={onCreate} type="button"><Plus size={17} /> 开始第一次排盘</button></section>;
}

function failureCode(reason: unknown): string | undefined {
  return reason instanceof ApiError && typeof reason.detail === "object" && reason.detail !== null
    ? String((reason.detail as { error?: unknown }).error ?? "")
    : undefined;
}

export function App() {
  const [cases, setCases] = useState<ResultCaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [snapshot, setSnapshot] = useState<RevisionSnapshot>();
  const [selection, setSelection] = useState<ResultSelection>();
  const lastSuccessful = useRef<RevisionSnapshot | undefined>(undefined);
  const [form, setForm] = useState<ProvidedTimeFormState>(() => emptyProvidedTimeForm());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [revisionCaseId, setRevisionCaseId] = useState<string>();
  const [showForm, setShowForm] = useState(false);
  const [caseDrawerOpen, setCaseDrawerOpen] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [exportStatus, setExportStatus] = useState<"" | ExportSaveResult>("");
  const [retainedSnapshotRisk, setRetainedSnapshotRisk] = useState(false);
  const caseTrigger = useRef<HTMLButtonElement>(null);
  const verificationTrigger = useRef<HTMLElement | null>(null);
  const isNarrow = typeof window !== "undefined" && window.innerWidth <= 560;

  const currentActionState = (): ResultsAppActionState<RevisionSnapshot, ResultSelection> => ({ snapshot, selection, retainedSnapshotRisk, showForm, revisionCaseId });
  const applyActionState = (next: ResultsAppActionState<RevisionSnapshot, ResultSelection>) => {
    applyResultsAppActionState(next, { setSnapshot, setSelection, setRetainedSnapshotRisk, setShowForm, setRevisionCaseId });
  };
  const commitSnapshot = useCallback((next: RevisionSnapshot) => {
    const state = resultsAppActions.commitSuccess({ snapshot, selection, retainedSnapshotRisk, showForm, revisionCaseId }, next);
    lastSuccessful.current = next;
    applyActionState(state);
    setExportStatus("");
  }, [retainedSnapshotRisk, revisionCaseId, selection, showForm, snapshot]);
  const retainSnapshot = useCallback((next: RevisionSnapshot) => {
    const state = resultsAppActions.restoreExistingFailure({ snapshot, selection, retainedSnapshotRisk, showForm, revisionCaseId }, next);
    lastSuccessful.current = next;
    applyActionState(state);
  }, [retainedSnapshotRisk, revisionCaseId, selection, showForm, snapshot]);
  const retainTargetYearFailure = useCallback((next: RevisionSnapshot) => {
    const state = resultsAppActions.targetYearFailure(currentActionState(), next);
    lastSuccessful.current = next;
    applyActionState(state);
  }, [retainedSnapshotRisk, revisionCaseId, selection, showForm, snapshot]);
  const selectOrReloadSnapshot = useCallback((next: RevisionSnapshot) => {
    const state = resultsAppActions.selectOrReload({ snapshot, selection, retainedSnapshotRisk, showForm, revisionCaseId }, next);
    lastSuccessful.current = next;
    applyActionState(state);
    if (!snapshot || snapshotIdentity(snapshot) !== snapshotIdentity(next)) setExportStatus("");
  }, [retainedSnapshotRisk, revisionCaseId, selection, showForm, snapshot]);

  const loadCases = useCallback(async (preferCaseId?: string, preserveRetainedRisk = false) => {
    const rows = await apiRequest<ResultCaseSummary[]>("/api/cases");
    setCases(rows);
    const item = preferredCaseSummary(rows, preferCaseId, selectedCaseId);
    if (!item) { setSelectedCaseId(""); setSnapshot(undefined); setSelection(undefined); setRetainedSnapshotRisk(false); setExportStatus(""); return; }
    const next = await apiRequest<RevisionSnapshot>(`/api/cases/${item.caseId}/revisions/${item.latestRevisionId}`);
    setSelectedCaseId(item.caseId);
    if (preserveRetainedRisk) retainTargetYearFailure(next); else selectOrReloadSnapshot(next);
  }, [retainTargetYearFailure, selectOrReloadSnapshot, selectedCaseId]);

  useEffect(() => { void loadCases().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "无法读取本地案例")).finally(() => setLoading(false)); }, []);

  const beginCreate = () => { applyActionState(resultsAppActions.beginCreate(currentActionState())); setForm(emptyProvidedTimeForm()); setFormErrors({}); setError(""); };
  const beginRevision = () => {
    if (!snapshot) return;
    setForm(formFromRevision(snapshot.input, snapshot.charts.targetYears));
    setFormErrors({}); setRevisionCaseId(snapshot.input.caseId); setShowForm(true); setError("");
  };

  const selectCase = async (item: ResultCaseSummary) => {
    setBusy(true); setError(""); setExportStatus("");
    try {
      const next = await apiRequest<RevisionSnapshot>(`/api/cases/${item.caseId}/revisions/${item.latestRevisionId}`);
      setSelectedCaseId(item.caseId); selectOrReloadSnapshot(next); setCaseDrawerOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "案例读取失败"); } finally { setBusy(false); }
  };

  const submitCase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice(""); setFormErrors({});
    const prior = revisionCaseId === undefined ? undefined : lastSuccessful.current;
    try {
      if (!form.date.trim()) throw new Error("请输入出生日期");
      const caseId = revisionCaseId ?? nextAvailableCaseId(Number(form.date.slice(0, 4)), cases.map((item) => item.caseId));
      const response = await apiRequest<CreateCaseResponse>(revisionCaseId === undefined ? "/api/cases" : `/api/cases/${revisionCaseId}/revisions`, { method: "POST", body: JSON.stringify(buildProvidedTimeRequest(form, { caseId })) });
      setSelectedCaseId(caseId); commitSnapshot(response.snapshot); setShowForm(false); setRevisionCaseId(undefined); setNotice("排盘已保存，可继续查看双盘结果。");
      await loadCases(caseId);
    } catch (reason) {
      setFormErrors(providedTimeFieldErrors(reason));
      setError(reason instanceof Error ? reason.message : "计算或保存失败");
      if (prior) { retainSnapshot(prior); setNotice("未能更新排盘，已保留上一次成功结果。可查看原因后再修改输入。"); }
      else applyActionState(resultsAppActions.keepNewCaseFailure(currentActionState()));
    } finally { setBusy(false); }
  };

  const updateTargetYears = async (nextYears: readonly number[], changedYear: number | undefined, action: "add" | "remove" | "refresh", page: TargetYearPage = "fortune") => {
    if (!snapshot || busy) return;
    const base = snapshot;
    setBusy(true); setError("");
    try {
      const targetYears = sortedTargetYears(nextYears);
      const response = await apiRequest<CreateCaseResponse>(`/api/cases/${base.input.caseId}/revisions/${base.manifest.revisionId}/target-years`, { method: "POST", body: JSON.stringify(resultsAppActions.targetYearRequest(targetYears)) });
      const initial = createResultSelection(response.snapshot);
      const nextSelection: ResultSelection = action === "refresh" || changedYear === undefined
        ? { ...initial, activePage: "fortune" }
        : selectionAfterTargetYearMutation(response.snapshot, { action, year: changedYear, page });
      const state = resultsAppActions.targetYearSuccess(currentActionState(), response.snapshot, nextSelection);
      lastSuccessful.current = response.snapshot;
      applyActionState(state);
      setExportStatus("");
      setNotice("目标流年已更新。");
      setCases((rows) => rows.map((item) => item.caseId === base.input.caseId ? { ...item, latestRevisionId: response.revision.revisionId } : item));
    } catch (reason) {
      if (failureCode(reason) === "TARGET_YEAR_OUTSIDE_SHARED_SUPPORTED_SET") {
        retainTargetYearFailure(base);
        try { await loadCases(base.input.caseId, true); } catch { retainTargetYearFailure(base); }
        setNotice("超出当前排盘可计算运限");
      } else { retainTargetYearFailure(base); setNotice("目标流年未更新，已保留上一次成功结果。"); setError(reason instanceof Error ? reason.message : "目标流年更新失败"); }
    } finally { setBusy(false); }
  };

  const recoverBaziDetail = () => {
    if (!snapshot) return;
    resultsAppActions.recoverBaziDetail({ schemaVersion: snapshot.input.schemaVersion, baziDetailStatus: snapshot.resultCapabilities.baziDetail.status, storedTargetYears: snapshot.charts.targetYears }, {
      openFreshProvidedTimeForm: beginRevision,
      updateStoredTargetYears: (targetYears) => void updateTargetYears(targetYears, undefined, "refresh")
    });
  };

  const saveDecision = async (payload: Record<string, unknown>) => {
    if (!snapshot) return;
    setBusy(true); setError("");
    try { const response = await apiRequest<CreateCaseResponse>(`/api/cases/${snapshot.input.caseId}/revisions/${snapshot.manifest.revisionId}/decision`, { method: "POST", body: JSON.stringify(payload) }); commitSnapshot(response.snapshot); setNotice("人工确认已保存。"); await loadCases(snapshot.input.caseId); } catch (reason) { setError(reason instanceof Error ? reason.message : "人工确认保存失败"); } finally { setBusy(false); }
  };
  const exportChartDocument = async () => {
    if (!snapshot || !selection) return;
    setBusy(true); setError("");
    try {
      const request = chartDocumentDownloadRequest(snapshot, selection);
      const result = await saveChartDocumentDownload({
        request: () => apiJsonDownload(request.path, request.options)
      });
      setExportStatus(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    } finally { setBusy(false); }
  };

  const openVerification = (trigger: HTMLElement | null) => { verificationTrigger.current = trigger; setExportStatus(""); setVerificationOpen(true); };
  const riskNotice = useMemo(() => snapshot && (retainedSnapshotRisk || snapshot.audit.blockingReasons?.length || snapshot.charts.candidates.length > 1) ? retainedSnapshotRisk ? "本次更新未成功，当前显示的是上一次成功结果；请查看原因后再继续。" : "当前结果保留多个可能候选或待处理差异；请在核验与导出中查看依据。" : "", [retainedSnapshotRisk, snapshot]);
  const fingerprint = snapshot && (typeof snapshot.audit.contentFingerprint === "string" ? snapshot.audit.contentFingerprint : snapshot.audit.contentFingerprint?.value) || snapshot?.manifest.contentFingerprint || "";
  const verificationIdentity = snapshot ? drawerIdentity(snapshot.input.caseId, snapshot.manifest.revisionId) : "";
  const changeSelection = (next: ResultSelection) => {
    setSelection(next);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".results-navigation button.active")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };

  return <div className="app-shell results-app-shell">
    <header className="topbar"><div className="brand"><div className="brand-seal">赛</div><strong>赛博大师·八字与紫微排盘计算器</strong></div><button className="button primary" onClick={beginCreate} type="button"><Plus size={16} /> 新建排盘</button></header>
    <div className="main-workspace">
      {error && <div className="toast error"><CircleAlert size={18} /><span>{error}</span><button aria-label="关闭提醒" onClick={() => setError("")} type="button"><X size={16} /></button></div>}
      {notice && <div className="toast success"><Check size={18} /><span>{notice}</span>{snapshot && notice.includes("保留") && <button className="button ghost" onClick={(event) => openVerification(event.currentTarget)} type="button">查看原因</button>}<button aria-label="关闭提醒" onClick={() => setNotice("")} type="button"><X size={16} /></button></div>}
      {loading ? <div className="loading-state"><LoaderCircle className="spin" size={28} /> 正在读取本地案例……</div> : showForm ? <ProvidedTimeForm busy={busy} errors={formErrors} form={form} onCancel={() => setShowForm(false)} onSubmit={submitCase} setForm={(next) => { setForm(next); setFormErrors({}); }} /> : snapshot && selection ? <>
        {riskNotice && <div className="persistent-risk-notice"><CircleAlert size={17} /><span>{riskNotice}</span><button className="button ghost" onClick={(event) => openVerification(event.currentTarget)} type="button">查看原因</button></div>}
        <ResultsShell caseName={snapshot.input.alias} isNarrow={isNarrow} onAddTargetYear={(year, page) => void updateTargetYears([...snapshot.charts.targetYears, year], year, "add", page)} onModifyInput={beginRevision} onOpenCaseDialog={() => { caseTrigger.current = document.querySelector<HTMLButtonElement>("[data-result-case-trigger]"); setCaseDrawerOpen(true); }} onOpenVerification={() => openVerification(document.querySelector<HTMLButtonElement>(".result-primary-action.primary"))} onRecoverBaziDetail={recoverBaziDetail} onRemoveTargetYear={(year, page) => void updateTargetYears(snapshot.charts.targetYears.filter((item) => item !== year), year, "remove", page)} onSelectionChange={changeSelection} selection={selection} snapshot={snapshot} />
      </> : <EmptyResults onCreate={beginCreate} />}
    </div>
    <CaseDrawer cases={cases} currentCaseId={selectedCaseId} onClose={() => setCaseDrawerOpen(false)} onCreate={() => { setCaseDrawerOpen(false); beginCreate(); }} onSelect={(item) => void selectCase(item)} open={caseDrawerOpen} returnFocus={caseTrigger.current} />
    {snapshot && <VerificationDrawer audit={<AuditPanel audit={snapshot.audit} busy={busy} identity={verificationIdentity} onDecision={saveDecision} open={verificationOpen} />} evidence={<TimeEvidencePanel evidence={snapshot.timeEvidence} />} exportPanel={<ExportPanel busy={busy} onExport={exportChartDocument} status={exportStatus} />} onClose={() => setVerificationOpen(false)} open={verificationOpen} returnFocus={verificationTrigger.current} technical={<dl className="technical-identity"><div><dt>修订编号</dt><dd>{snapshot.manifest.revisionId}</dd></div><div><dt>审计等级</dt><dd>{snapshot.audit.auditLevel}</dd></div><div><dt>内容指纹</dt><dd><code>{fingerprint}</code></dd></div></dl>} />}
  </div>;
}
