import type { BirthRecordV1, TimeEvidenceV1 } from "../../shared/contracts.js";
import type {
  BirthRecordV2,
  TimeEvidenceV2
} from "../../shared/provided-time-contracts.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import { BAZI_ENGINE, calculateBaziChart } from "./bazi.js";
import { resolveTargetYears } from "./input.js";
import type { ChartCalculationOptions, DualTrackChartSetV1 } from "./types.js";
import { calculateZiweiChart, ZIWEI_ENGINE } from "./ziwei.js";

export { BAZI_ENGINE, calculateBaziChart } from "./bazi.js";
export { calculateZiweiChart, ZIWEI_ENGINE } from "./ziwei.js";
export {
  assertTargetYearsWithinSharedSupportedSet,
  BaziDetailGenerationError,
  buildBaziDetailV1,
  resolveSharedSupportedTargetYears,
  TargetYearOutsideSharedSupportedSetError,
  truncateEngineDateTimeToMinute
} from "./bazi-detail.js";
export type { BaziDetailFailureCode } from "./bazi-detail.js";
export {
  BAZI_DETAIL_FINGERPRINT_DOMAINS,
  baziDetailFingerprintPreimage,
  computeBaziDetailFingerprint,
  computeBaziDetailSourceIdentity,
  computeSourceBaziCandidateFingerprint,
  parseBoundBaziDetail
} from "./bazi-detail-fingerprints.js";
export {
  BaziDetailV1Schema
} from "./bazi-detail-contract.js";
export type {
  BaziAnnualDetailV1,
  BaziAuxiliaryPillarV1,
  BaziDaYunDetailV1,
  BaziDetailCandidateV1,
  BaziDetailV1,
  BaziGanZhiRelationsV1,
  BaziLiuYueDetailV1,
  BaziXiaoYunDetailV1,
  EngineSolarTermBoundaryV1
} from "./bazi-detail-contract.js";
export type { BaziDetailFingerprintDomain, BaziDetailSourcesV1 } from "./bazi-detail-fingerprints.js";
export type * from "./types.js";

type ChartRecord = BirthRecordV1 | BirthRecordV2;
type ChartEvidence = TimeEvidenceV1 | TimeEvidenceV2;

function assertSharedIdentity(record: ChartRecord, evidence: ChartEvidence): void {
  if (record.schemaVersion !== evidence.schemaVersion) {
    throw new Error("SOURCE_RECORD_CONTRACT_MISMATCH: BirthRecord 与 TimeEvidence 的契约版本不一致");
  }
  if (record.caseId !== evidence.caseId) {
    throw new Error("SOURCE_RECORD_CASE_ID_MISMATCH: BirthRecord 与 TimeEvidence 的 caseId 不一致");
  }
  if (
    record.calendar.type !== evidence.originalCalendar.type
    || record.calendar.date !== evidence.originalCalendar.date
    || record.calendar.leapMonth !== evidence.originalCalendar.leapMonth
  ) {
    throw new Error("SOURCE_RECORD_CALENDAR_MISMATCH: BirthRecord 与 TimeEvidence 的原始历法不一致");
  }
}

function assertEvidenceMatchesRecord(record: ChartRecord, evidence: ChartEvidence): void {
  assertSharedIdentity(record, evidence);
  if (record.schemaVersion === "1.0.0" && evidence.schemaVersion === "1.0.0") {
    if (record.birthTime.localTime !== evidence.originalLocalTime) {
      throw new Error("SOURCE_RECORD_LOCAL_TIME_MISMATCH: BirthRecord 与 TimeEvidence 的原始时间不一致");
    }
    if (record.location.timeZone !== evidence.timeZone) {
      throw new Error("SOURCE_RECORD_TIMEZONE_MISMATCH: BirthRecord 与 TimeEvidence 的时区不一致");
    }
    if (record.location.longitude !== evidence.longitude) {
      throw new Error("SOURCE_RECORD_LONGITUDE_MISMATCH: BirthRecord 与 TimeEvidence 的经度不一致");
    }
    if (record.location.latitude !== evidence.latitude) {
      throw new Error("SOURCE_RECORD_LATITUDE_MISMATCH: BirthRecord 与 TimeEvidence 的纬度不一致");
    }
    if (record.location.clockConvention !== evidence.clockConvention) {
      throw new Error("SOURCE_RECORD_CLOCK_CONVENTION_MISMATCH: BirthRecord 与 TimeEvidence 的时制不一致");
    }
  } else if (record.schemaVersion === "2.0.0" && evidence.schemaVersion === "2.0.0") {
    if (record.providedTime.localTime !== evidence.originalLocalTime) {
      throw new Error("SOURCE_RECORD_LOCAL_TIME_MISMATCH: BirthRecord 与 TimeEvidence 的原始时间不一致");
    }
    if (record.providedTime.basis !== evidence.originalTimeBasis) {
      throw new Error("SOURCE_RECORD_TIME_BASIS_MISMATCH: BirthRecord 与 TimeEvidence 的时间口径不一致");
    }
  } else {
    throw new Error("SOURCE_RECORD_CONTRACT_MISMATCH: BirthRecord 与 TimeEvidence 的契约版本不一致");
  }
  if (sourceRecordFingerprint(record) !== evidence.sourceRecordFingerprint) {
    throw new Error("SOURCE_RECORD_FINGERPRINT_MISMATCH: TimeEvidence 不属于当前 BirthRecord 公开修订");
  }
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) {
      return difference;
    }
  }

  return leftPoints.length - rightPoints.length;
}

export function calculateCandidateCharts(
  record: BirthRecordV1,
  evidence: TimeEvidenceV1,
  options?: ChartCalculationOptions
): DualTrackChartSetV1;
export function calculateCandidateCharts(
  record: BirthRecordV2,
  evidence: TimeEvidenceV2,
  options?: ChartCalculationOptions
): DualTrackChartSetV1;
export function calculateCandidateCharts(
  record: ChartRecord,
  evidence: ChartEvidence,
  options: ChartCalculationOptions = {}
): DualTrackChartSetV1 {
  assertEvidenceMatchesRecord(record, evidence);
  const birthYears = evidence.calendarResolutions
    .filter((resolution) => resolution.status === "valid" && resolution.solarDate !== null)
    .map((resolution) => Number(resolution.solarDate!.slice(0, 4)));
  const fallbackYear = Number(evidence.candidates[0].localDateTime.slice(0, 4));
  const calculationYear = birthYears.length === 0 ? fallbackYear : Math.min(...birthYears);
  const birthYear = birthYears.length === 0 ? fallbackYear : Math.max(...birthYears);
  const targetYears = resolveTargetYears(calculationYear, options);
  const beforeBirth = targetYears.find((targetYear) => targetYear < birthYear);
  if (beforeBirth !== undefined) {
    throw new Error(`TARGET_YEAR_BEFORE_BIRTH:${beforeBirth}`);
  }
  const normalizedOptions = { ...options, targetYears, yearRange: undefined };
  const candidates = [...evidence.candidates]
    .sort((left, right) => compareUnicodeCodePoints(left.id, right.id))
    .map((candidate) => ({
      candidateId: candidate.id,
      basis: candidate.basis,
      dayBoundary: candidate.dayBoundary,
      calendarResolutionId: candidate.calendarResolutionId,
      calendarBasis: candidate.calendarBasis,
      bazi: calculateBaziChart(record, candidate, normalizedOptions),
      ziwei: calculateZiweiChart(record, candidate, normalizedOptions)
    }));
  return {
    schemaVersion: "1.0.0",
    caseId: record.caseId,
    timeRulesetVersion: evidence.rulesetVersion,
    engineVersions: {
      bazi: BAZI_ENGINE,
      ziwei: ZIWEI_ENGINE
    },
    chartRulesetVersions: {
      bazi: "CyberSaga-Bazi-v1",
      ziwei: "CyberSaga-Ziwei-v1"
    },
    targetYears,
    candidates
  };
}
