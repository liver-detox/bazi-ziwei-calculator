import { LocalDate } from "@js-joda/core";
import { canonicalize } from "json-canonicalize";

import {
  DualTrackChartSetAuditSchema,
  materialBaziProjection,
  materialZiweiProjection,
  type JsonValue
} from "../audit/index.js";
import { calculateCandidateCharts } from "../charts/index.js";
import { normalizeBirthTime } from "../time/normalize-birth-time.js";
import { normalizeProvidedTime } from "../time/normalize-provided-time.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import {
  BirthRecordV1Schema,
  PublicBirthRecordV2Schema,
  TimeEvidenceV1Schema,
  TimeEvidenceV2Schema
} from "../../shared/contracts.js";
import type { ReviewSubject } from "./subject-revision.js";

export interface AlternativeTimeMaterialityInput {
  subject: ReviewSubject;
  alternativeLocalTime: string;
}

export type AlternativeTimeMateriality = "none" | "chart_change" | "unresolved";

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const PROVIDED_LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d)$/u;
const FULL_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/u;

type TimeCandidate =
  | ReturnType<typeof TimeEvidenceV1Schema.parse>["candidates"][number]
  | ReturnType<typeof TimeEvidenceV2Schema.parse>["candidates"][number];
type ChartSet = ReturnType<typeof DualTrackChartSetAuditSchema.parse>;
type ChartCandidate = ChartSet["candidates"][number];

function canonical(value: JsonValue): string {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new TypeError("实质性投影无法规范序列化");
  return result;
}

function effectiveSeconds(minutes: number | null, seconds: number | undefined): number | null {
  return seconds ?? (minutes === null ? null : minutes * 60);
}

function materialBaziMinuteReplayProjection(rawChart: unknown): JsonValue {
  const projection = structuredClone(materialBaziProjection(rawChart));
  if (
    projection === null
    || Array.isArray(projection)
    || typeof projection !== "object"
    || projection.luck === null
    || Array.isArray(projection.luck)
    || typeof projection.luck !== "object"
    || typeof projection.luck.startSolarDateTime !== "string"
  ) {
    throw new TypeError("八字起运时刻投影不完整");
  }
  const match = FULL_DATE_TIME.exec(projection.luck.startSolarDateTime);
  if (match === null) throw new TypeError("八字起运时刻格式不符合锁定引擎输出");
  try {
    LocalDate.parse(match[1]);
  } catch {
    throw new TypeError("八字起运时刻包含无效公历日期");
  }
  projection.luck.startSolarDateTime = match[1];
  return projection;
}

function timeDecisionProjection(candidate: TimeCandidate): JsonValue {
  if (!("offset" in candidate)) {
    return {
      basis: candidate.basis,
      calendarBasis: candidate.calendarBasis,
      earthlyBranch: {
        index: candidate.earthlyBranch.index,
        name: candidate.earthlyBranch.name
      },
      ziSegment: candidate.ziSegment,
      dayBoundary: candidate.dayBoundary
    };
  }
  const correction = candidate.trueSolarCorrection;
  return {
    basis: candidate.basis,
    calendarBasis: candidate.calendarBasis ?? null,
    earthlyBranch: {
      index: candidate.earthlyBranch.index,
      name: candidate.earthlyBranch.name
    },
    ziSegment: candidate.ziSegment,
    dayBoundary: candidate.dayBoundary,
    offset: candidate.offset,
    standardOffset: candidate.standardOffset,
    dstSeconds: effectiveSeconds(candidate.dstMinutes, candidate.dstSeconds),
    trueSolarDstRemovedSeconds: correction === null
      ? null
      : effectiveSeconds(correction.dstRemovedMinutes, correction.dstRemovedSeconds)
  };
}

function candidateKey(candidate: TimeCandidate): string {
  return canonical({
    basis: candidate.basis,
    calendarBasis: candidate.calendarBasis ?? null,
    dayBoundary: candidate.dayBoundary,
    ...("offset" in candidate ? { offset: candidate.offset } : {})
  });
}

function chartCandidatesById(chartSet: ChartSet): Map<string, ChartCandidate> {
  const byId = new Map<string, ChartCandidate>();
  for (const candidate of chartSet.candidates) {
    if (byId.has(candidate.candidateId)) throw new TypeError("盘集 candidateId 重复");
    if ("status" in candidate.bazi || "status" in candidate.ziwei) {
      throw new TypeError("分路排盘不完整");
    }
    byId.set(candidate.candidateId, candidate);
  }
  return byId;
}

function groupedCandidateSignatures(
  candidates: readonly TimeCandidate[],
  chartSet: ChartSet
): Map<string, string[]> {
  const chartById = chartCandidatesById(chartSet);
  if (candidates.length !== chartSet.candidates.length) throw new TypeError("时间候选与盘集数量不一致");
  const seenIds = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) throw new TypeError("时间候选 ID 重复");
    seenIds.add(candidate.id);
    const chart = chartById.get(candidate.id);
    if (
      chart === undefined
      || chart.basis !== candidate.basis
      || chart.dayBoundary !== candidate.dayBoundary
      || chart.calendarResolutionId !== candidate.calendarResolutionId
      || chart.calendarBasis !== candidate.calendarBasis
    ) {
      throw new TypeError("时间候选与双轨盘身份不一致");
    }
    const signature = canonical({
      time: timeDecisionProjection(candidate),
      bazi: materialBaziMinuteReplayProjection(chart.bazi),
      ziwei: materialZiweiProjection(chart.ziwei)
    });
    const key = candidateKey(candidate);
    const group = groups.get(key) ?? [];
    group.push(signature);
    groups.set(key, group);
  }
  if (chartById.size !== seenIds.size) throw new TypeError("盘集存在无时间证据候选");
  for (const group of groups.values()) group.sort();
  return groups;
}

function equalGroupedMultisets(left: Map<string, string[]>, right: Map<string, string[]>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, leftGroup] of left) {
    const rightGroup = right.get(key);
    if (
      rightGroup === undefined
      || leftGroup.length !== rightGroup.length
      || leftGroup.some((signature, index) => signature !== rightGroup[index])
    ) return false;
  }
  return true;
}

function assertReplayHeadersMatch(original: ChartSet, replayed: ChartSet): void {
  const header = (chartSet: ChartSet): JsonValue => ({
    schemaVersion: chartSet.schemaVersion,
    caseId: chartSet.caseId,
    timeRulesetVersion: chartSet.timeRulesetVersion,
    engineVersions: chartSet.engineVersions,
    chartRulesetVersions: chartSet.chartRulesetVersions,
    targetYears: chartSet.targetYears
  });
  if (canonical(header(original)) !== canonical(header(replayed))) {
    throw new TypeError("原盘与备用分钟的引擎、规则或年份不一致");
  }
}

function assertStoredBaselineMatchesReplay(
  storedEvidence: ReturnType<typeof TimeEvidenceV1Schema.parse> | ReturnType<typeof TimeEvidenceV2Schema.parse>,
  replayedEvidence: ReturnType<typeof TimeEvidenceV1Schema.parse> | ReturnType<typeof TimeEvidenceV2Schema.parse>,
  storedCharts: ChartSet,
  replayedCharts: ChartSet
): void {
  if (
    canonicalize(storedEvidence) !== canonicalize(replayedEvidence)
    || canonicalize(storedCharts) !== canonicalize(replayedCharts)
  ) {
    throw new TypeError("主体时间证据或盘集与出生记录基线重放不一致");
  }
}

export function replayAlternativeMinute(
  subject: ReviewSubject,
  alternativeLocalTime: string
): {
  evidence: ReturnType<typeof TimeEvidenceV1Schema.parse> | ReturnType<typeof TimeEvidenceV2Schema.parse>;
  charts: ChartSet;
} {
  const dated = PROVIDED_LOCAL_DATE_TIME.exec(alternativeLocalTime);
  const localTime = dated?.[2] ?? alternativeLocalTime;
  if (!LOCAL_TIME.test(localTime)) throw new TypeError("备选时间必须使用 HH:mm");
  if (subject.subjectContract !== "location_time_v1") {
    const record = PublicBirthRecordV2Schema.parse(subject.birthRecord);
    const alternativeRecord = structuredClone(record);
    alternativeRecord.providedTime.localTime = localTime;
    if (dated !== null && record.calendar.type === "solar") {
      try {
        LocalDate.parse(dated[1]);
      } catch {
        throw new TypeError("备选日期必须是有效公历日期");
      }
    }
    if (dated !== null) alternativeRecord.calendar.date = dated[1];
    const evidence = normalizeProvidedTime(alternativeRecord);
    return {
      evidence,
      charts: DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
        alternativeRecord,
        evidence,
        { targetYears: subject.charts.targetYears }
      ))
    };
  }
  if (dated !== null) throw new TypeError("历史 V1 分钟重放不接受带日期输入");
  const record = BirthRecordV1Schema.parse(subject.birthRecord);
  const alternativeRecord = structuredClone(record);
  alternativeRecord.birthTime.localTime = localTime;
  const evidence = normalizeBirthTime(alternativeRecord);
  return {
    evidence,
    charts: DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
      alternativeRecord,
      evidence,
      { targetYears: subject.charts.targetYears }
    ))
  };
}

function processLevelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: unknown; code?: unknown; signal?: unknown; message?: unknown };
  if (value.name === "AbortError") return true;
  if (value.code === "ABORT_ERR" || value.code === "ENOMEM" || value.code === "EINTR" || value.code === "ERR_WORKER_OUT_OF_MEMORY") {
    return true;
  }
  if (typeof value.signal === "string" && value.signal.length > 0) return true;
  return typeof value.message === "string"
    && /(?:heap out of memory|out of memory|allocation failed)/iu.test(value.message);
}

export function assessAlternativeTimeMateriality(
  input: AlternativeTimeMaterialityInput
): AlternativeTimeMateriality {
  if (!LOCAL_TIME.test(input.alternativeLocalTime)) return "unresolved";
  try {
    const originalRecord = input.subject.subjectContract !== "location_time_v1"
      ? PublicBirthRecordV2Schema.parse(input.subject.birthRecord)
      : BirthRecordV1Schema.parse(input.subject.birthRecord);
    const originalEvidence = input.subject.subjectContract !== "location_time_v1"
      ? TimeEvidenceV2Schema.parse(input.subject.timeEvidence)
      : TimeEvidenceV1Schema.parse(input.subject.timeEvidence);
    const originalCharts = DualTrackChartSetAuditSchema.parse(input.subject.charts);
    const originalLocalTime = originalRecord.schemaVersion === "2.0.0"
      ? originalRecord.providedTime.localTime
      : originalRecord.birthTime.localTime;
    if (
      originalLocalTime !== originalEvidence.originalLocalTime
      || originalRecord.caseId !== originalEvidence.caseId
      || originalRecord.caseId !== originalCharts.caseId
      || sourceRecordFingerprint(originalRecord) !== originalEvidence.sourceRecordFingerprint
      || (originalRecord.schemaVersion === "2.0.0"
        && originalEvidence.schemaVersion === "2.0.0"
        && originalRecord.providedTime.basis !== originalEvidence.originalTimeBasis)
    ) throw new TypeError("原始记录、时间证据与盘集绑定不一致");

    const baseline = originalRecord.schemaVersion === "2.0.0"
      ? (() => {
          const evidence = normalizeProvidedTime(originalRecord);
          return {
            evidence,
            charts: DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
              originalRecord,
              evidence,
              { targetYears: originalCharts.targetYears }
            ))
          };
        })()
      : (() => {
          const evidence = normalizeBirthTime(originalRecord);
          return {
            evidence,
            charts: DualTrackChartSetAuditSchema.parse(calculateCandidateCharts(
              originalRecord,
              evidence,
              { targetYears: originalCharts.targetYears }
            ))
          };
        })();
    assertStoredBaselineMatchesReplay(
      originalEvidence,
      baseline.evidence,
      originalCharts,
      baseline.charts
    );

    const replayed = replayAlternativeMinute(input.subject, input.alternativeLocalTime);
    const alternativeEvidence = replayed.evidence;
    const alternativeCharts = replayed.charts;
    assertReplayHeadersMatch(originalCharts, alternativeCharts);

    const originalGroups = groupedCandidateSignatures(originalEvidence.candidates, originalCharts);
    const alternativeGroups = groupedCandidateSignatures(alternativeEvidence.candidates, alternativeCharts);
    return equalGroupedMultisets(originalGroups, alternativeGroups) ? "none" : "chart_change";
  } catch (error) {
    if (processLevelError(error)) throw error;
    return "unresolved";
  }
}
