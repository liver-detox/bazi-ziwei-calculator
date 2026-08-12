import type {
  BaziAnnualDetailV1,
  BaziDaYunDetailV1,
  BaziDetailCandidateV1,
  BaziDetailV1,
  BaziLiuYueDetailV1
} from "../core/charts/bazi-detail-contract.js";
import type {
  BaziAnnualFortune,
  BaziDaYun,
  CandidateDualChartV1,
  DualTrackChartSetV1
} from "../core/charts/types.js";
import type { ResultCapabilities } from "../core/workbench/case-workbench.js";
import type { TimeEvidenceAny } from "../shared/contracts.js";

export const RESULT_PAGES = [
  { id: "overview", label: "双盘总览" },
  { id: "bazi", label: "八字详盘" },
  { id: "fortune", label: "大运流年" },
  { id: "ziwei", label: "紫微详盘" }
] as const;

export interface ResultSelection {
  activePage: "overview" | "bazi" | "fortune" | "ziwei";
  candidateId: string;
  selectedTargetYear: number | null;
  viewingDaYunIndex: number;
  selectedLiuYueOrdinal: number | null;
  ziweiMode: "natal" | "yearly";
}

export type TargetYearPage = "fortune" | "ziwei";

export interface TargetYearMutation {
  action: "add" | "remove";
  year: number;
  page: TargetYearPage;
}

type ResultTimeCandidate = Pick<TimeEvidenceAny["candidates"][number], "id" | "preferred">;

export interface ResultSnapshotInput {
  charts: DualTrackChartSetV1;
  timeEvidence: { candidates: ResultTimeCandidate[] };
  audit: {
    manualDecision?: {
      status: string;
      selectedCandidateId: string | null;
    };
  };
  baziDetail: BaziDetailV1 | null;
  resultCapabilities: ResultCapabilities;
}

export type ResultJoinErrorCode =
  | "CANDIDATE_EMPTY"
  | "CANDIDATE_CHART_MISSING"
  | "CANDIDATE_CHART_DUPLICATE"
  | "CANDIDATE_BAZI_MISMATCH"
  | "CANDIDATE_ZIWEI_MISMATCH"
  | "CANDIDATE_TIME_MISSING"
  | "CANDIDATE_TIME_DUPLICATE"
  | "CANDIDATE_DETAIL_MISSING"
  | "CANDIDATE_DETAIL_DUPLICATE"
  | "DAYUN_BASE_MISSING"
  | "DAYUN_BASE_DUPLICATE"
  | "DAYUN_DETAIL_MISSING"
  | "DAYUN_DETAIL_DUPLICATE"
  | "ANNUAL_YEAR_MISSING"
  | "ANNUAL_YEAR_DUPLICATE"
  | "ANNUAL_BASE_MISSING"
  | "ANNUAL_BASE_DUPLICATE"
  | "ANNUAL_SELECTION_MISMATCH"
  | "ANNUAL_DETAIL_MISSING"
  | "ANNUAL_DETAIL_DUPLICATE"
  | "ANNUAL_DETAIL_SELECTION_MISMATCH";

export class ResultJoinError extends Error {
  readonly code: ResultJoinErrorCode;

  constructor(code: ResultJoinErrorCode) {
    super(code);
    this.name = "ResultJoinError";
    this.code = code;
  }
}

export interface LiuYueChoice {
  ordinal: number;
  text: string;
  ariaCurrent: "true" | undefined;
  detail: BaziLiuYueDetailV1;
}

export interface ResultPresentation {
  candidateId: string;
  chart: CandidateDualChartV1;
  timeCandidate: ResultTimeCandidate;
  baziDetail:
    | { availability: "available"; candidate: BaziDetailCandidateV1 }
    | { availability: "unavailable"; capability: ResultCapabilities["baziDetail"] };
  daYun: {
    base: BaziDaYun;
    detail: BaziDaYunDetailV1 | null;
  } | null;
  annual: {
    base: BaziAnnualFortune;
    detail: BaziAnnualDetailV1 | null;
    liuYueChoices: LiuYueChoice[];
  } | null;
}

function exactOne<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
  missing: ResultJoinErrorCode,
  duplicate: ResultJoinErrorCode
): T {
  const matches = values.filter(predicate);
  if (matches.length === 0) throw new ResultJoinError(missing);
  if (matches.length > 1) throw new ResultJoinError(duplicate);
  return matches[0];
}

function chartForCandidate(snapshot: ResultSnapshotInput, candidateId: string): CandidateDualChartV1 {
  const chart = exactOne(
    snapshot.charts.candidates,
    (candidate) => candidate.candidateId === candidateId,
    "CANDIDATE_CHART_MISSING",
    "CANDIDATE_CHART_DUPLICATE"
  );
  if (chart.bazi.candidateId !== candidateId) throw new ResultJoinError("CANDIDATE_BAZI_MISMATCH");
  if (chart.ziwei.candidateId !== candidateId) throw new ResultJoinError("CANDIDATE_ZIWEI_MISMATCH");
  return chart;
}

function annualForYear(chart: CandidateDualChartV1, year: number): BaziAnnualFortune {
  return exactOne(
    chart.bazi.annualFortunes,
    (annual) => annual.year === year,
    "ANNUAL_YEAR_MISSING",
    "ANNUAL_YEAR_DUPLICATE"
  );
}

function sortedAnnuals(chart: CandidateDualChartV1): BaziAnnualFortune[] {
  return [...chart.bazi.annualFortunes].sort((left, right) => (
    left.year - right.year || left.daYunIndex - right.daYunIndex
  ));
}

function firstDaYunIndex(chart: CandidateDualChartV1): number {
  const first = [...chart.bazi.luck.daYun].sort((left, right) => left.index - right.index)[0];
  if (first === undefined) throw new ResultJoinError("DAYUN_BASE_MISSING");
  return first.index;
}

export function createResultSelection(snapshot: ResultSnapshotInput): ResultSelection {
  const chartIds = new Set(snapshot.charts.candidates.map((candidate) => candidate.candidateId));
  const manualCandidateId = snapshot.audit.manualDecision?.status === "selected"
    ? snapshot.audit.manualDecision.selectedCandidateId
    : null;
  const preferredCandidateId = snapshot.timeEvidence.candidates.find((candidate) => (
    candidate.preferred && chartIds.has(candidate.id)
  ))?.id;
  const candidateId = manualCandidateId !== null && chartIds.has(manualCandidateId)
    ? manualCandidateId
    : preferredCandidateId ?? snapshot.charts.candidates[0]?.candidateId;
  if (candidateId === undefined) throw new ResultJoinError("CANDIDATE_EMPTY");

  const chart = chartForCandidate(snapshot, candidateId);
  const firstAnnual = sortedAnnuals(chart)[0];
  return {
    activePage: "overview",
    candidateId,
    selectedTargetYear: firstAnnual?.year ?? null,
    viewingDaYunIndex: firstAnnual?.daYunIndex ?? firstDaYunIndex(chart),
    selectedLiuYueOrdinal: firstAnnual === undefined ? null : 1,
    ziweiMode: "natal"
  };
}

export function shouldShowCandidateChooser(snapshot: ResultSnapshotInput): boolean {
  return snapshot.charts.candidates.length > 1;
}

export function selectResultCandidate(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  candidateId: string
): ResultSelection {
  const chart = chartForCandidate(snapshot, candidateId);
  if (selection.selectedTargetYear !== null) {
    const retained = chart.bazi.annualFortunes.filter((annual) => annual.year === selection.selectedTargetYear);
    if (retained.length > 1) throw new ResultJoinError("ANNUAL_YEAR_DUPLICATE");
    if (retained.length === 1) {
      return {
        ...selection,
        candidateId,
        viewingDaYunIndex: retained[0].daYunIndex,
        selectedLiuYueOrdinal: 1
      };
    }
  }

  const keepsDaYun = chart.bazi.luck.daYun.some((daYun) => daYun.index === selection.viewingDaYunIndex);
  return {
    ...selection,
    candidateId,
    selectedTargetYear: null,
    viewingDaYunIndex: keepsDaYun ? selection.viewingDaYunIndex : firstDaYunIndex(chart),
    selectedLiuYueOrdinal: null
  };
}

export function selectTargetYear(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  year: number
): ResultSelection {
  const annual = annualForYear(chartForCandidate(snapshot, selection.candidateId), year);
  return {
    ...selection,
    selectedTargetYear: annual.year,
    viewingDaYunIndex: annual.daYunIndex,
    selectedLiuYueOrdinal: 1
  };
}

export function selectLiuYue(selection: ResultSelection, ordinal: number): ResultSelection {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 12) {
    throw new RangeError("流月序号必须是 1–12");
  }
  return { ...selection, selectedLiuYueOrdinal: ordinal };
}

export function selectZiweiMode(
  selection: ResultSelection,
  ziweiMode: ResultSelection["ziweiMode"]
): ResultSelection {
  return { ...selection, ziweiMode };
}

export function selectDaYun(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  daYunIndex: number
): ResultSelection {
  const chart = chartForCandidate(snapshot, selection.candidateId);
  exactOne(
    chart.bazi.luck.daYun,
    (daYun) => daYun.index === daYunIndex,
    "DAYUN_BASE_MISSING",
    "DAYUN_BASE_DUPLICATE"
  );
  const firstAnnual = sortedAnnuals(chart).find((annual) => annual.daYunIndex === daYunIndex);
  return {
    ...selection,
    viewingDaYunIndex: daYunIndex,
    selectedTargetYear: firstAnnual?.year ?? null,
    selectedLiuYueOrdinal: firstAnnual === undefined ? null : 1
  };
}

export function addTargetYearToSelection(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  year: number
): ResultSelection {
  return { ...selectTargetYear(selection, snapshot, year), activePage: "fortune" };
}

export function deleteTargetYearFromSelection(
  selection: ResultSelection,
  snapshot: ResultSnapshotInput,
  deletedYear: number
): ResultSelection {
  if (selection.selectedTargetYear !== deletedYear) return selection;
  const remaining = sortedAnnuals(chartForCandidate(snapshot, selection.candidateId))
    .filter((annual) => annual.year !== deletedYear);
  const next = remaining.find((annual) => annual.year > deletedYear)
    ?? remaining.at(-1);
  if (next === undefined) {
    return { ...selection, selectedTargetYear: null, selectedLiuYueOrdinal: null };
  }
  return {
    ...selection,
    selectedTargetYear: next.year,
    viewingDaYunIndex: next.daYunIndex,
    selectedLiuYueOrdinal: 1
  };
}

export function selectionAfterTargetYearMutation(
  snapshot: ResultSnapshotInput,
  mutation: TargetYearMutation
): ResultSelection {
  const initial = createResultSelection(snapshot);
  const chart = chartForCandidate(snapshot, initial.candidateId);
  const selected = mutation.action === "add"
    ? selectTargetYear(initial, snapshot, mutation.year)
    : (() => {
        const remaining = sortedAnnuals(chart);
        const next = remaining.find((annual) => annual.year > mutation.year) ?? remaining.at(-1);
        return next === undefined ? initial : selectTargetYear(initial, snapshot, next.year);
      })();
  return mutation.page === "ziwei"
    ? { ...selected, activePage: "ziwei", ziweiMode: selected.selectedTargetYear === null ? "natal" : "yearly" }
    : { ...selected, activePage: "fortune" };
}

function presentBaseDaYun(chart: CandidateDualChartV1, index: number): BaziDaYun {
  return exactOne(
    chart.bazi.luck.daYun,
    (daYun) => daYun.index === index,
    "DAYUN_BASE_MISSING",
    "DAYUN_BASE_DUPLICATE"
  );
}

function presentBaseAnnual(
  chart: CandidateDualChartV1,
  year: number,
  daYunIndex: number
): BaziAnnualFortune {
  const exact = chart.bazi.annualFortunes.filter((annual) => (
    annual.year === year && annual.daYunIndex === daYunIndex
  ));
  if (exact.length > 1) throw new ResultJoinError("ANNUAL_BASE_DUPLICATE");
  if (exact.length === 1) return exact[0];
  if (chart.bazi.annualFortunes.some((annual) => annual.year === year)) {
    throw new ResultJoinError("ANNUAL_SELECTION_MISMATCH");
  }
  throw new ResultJoinError("ANNUAL_BASE_MISSING");
}

function presentDetailAnnual(
  candidate: BaziDetailCandidateV1,
  year: number,
  daYunIndex: number
): BaziAnnualDetailV1 {
  const exact = candidate.annualDetails.filter((annual) => (
    annual.year === year && annual.daYunIndex === daYunIndex
  ));
  if (exact.length > 1) throw new ResultJoinError("ANNUAL_DETAIL_DUPLICATE");
  if (exact.length === 1) return exact[0];
  if (candidate.annualDetails.some((annual) => annual.year === year)) {
    throw new ResultJoinError("ANNUAL_DETAIL_SELECTION_MISMATCH");
  }
  throw new ResultJoinError("ANNUAL_DETAIL_MISSING");
}

export function presentResults(
  snapshot: ResultSnapshotInput,
  selection: ResultSelection
): ResultPresentation {
  const chart = chartForCandidate(snapshot, selection.candidateId);
  const timeCandidate = exactOne(
    snapshot.timeEvidence.candidates,
    (candidate) => candidate.id === selection.candidateId,
    "CANDIDATE_TIME_MISSING",
    "CANDIDATE_TIME_DUPLICATE"
  );
  const baseDaYun = presentBaseDaYun(chart, selection.viewingDaYunIndex);
  const baseAnnual = selection.selectedTargetYear === null
    ? null
    : presentBaseAnnual(chart, selection.selectedTargetYear, selection.viewingDaYunIndex);

  if (snapshot.baziDetail === null) {
    return {
      candidateId: selection.candidateId,
      chart,
      timeCandidate,
      baziDetail: {
        availability: "unavailable",
        capability: snapshot.resultCapabilities.baziDetail
      },
      daYun: { base: baseDaYun, detail: null },
      annual: baseAnnual === null
        ? null
        : { base: baseAnnual, detail: null, liuYueChoices: [] }
    };
  }

  const detailCandidate = exactOne(
    snapshot.baziDetail.candidates,
    (candidate) => candidate.candidateId === selection.candidateId,
    "CANDIDATE_DETAIL_MISSING",
    "CANDIDATE_DETAIL_DUPLICATE"
  );
  const detailDaYun = exactOne(
    detailCandidate.daYunDetails,
    (daYun) => daYun.index === selection.viewingDaYunIndex,
    "DAYUN_DETAIL_MISSING",
    "DAYUN_DETAIL_DUPLICATE"
  );
  const detailAnnual = selection.selectedTargetYear === null
    ? null
    : presentDetailAnnual(detailCandidate, selection.selectedTargetYear, selection.viewingDaYunIndex);
  const liuYueChoices = detailAnnual?.liuYue.map((month) => ({
    ordinal: month.ordinal,
    text: month.monthName,
    ariaCurrent: month.ordinal === selection.selectedLiuYueOrdinal ? "true" as const : undefined,
    detail: month
  })) ?? [];

  return {
    candidateId: selection.candidateId,
    chart,
    timeCandidate,
    baziDetail: { availability: "available", candidate: detailCandidate },
    daYun: { base: baseDaYun, detail: detailDaYun },
    annual: baseAnnual === null || detailAnnual === null
      ? null
      : { base: baseAnnual, detail: detailAnnual, liuYueChoices }
  };
}
