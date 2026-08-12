import { LocalDateTime } from "@js-joda/core";

import {
  PublicBirthRecordV2Schema,
  TimeEvidenceV2Schema,
  type PublicBirthRecordV2,
  type TimeEvidenceV2
} from "../../shared/provided-time-contracts.js";
import {
  resolveCalendarResolutions,
  type CalendarBasis,
  type ValidCalendarResolution
} from "./calendar-resolution.js";
import { sourceRecordFingerprint } from "./source-record-fingerprint.js";

type Candidate = TimeEvidenceV2["candidates"][number];
type Issue = TimeEvidenceV2["issues"][number];

const BRANCHES = [
  { index: 0, name: "子", range: "23:00~01:00" },
  { index: 1, name: "丑", range: "01:00~03:00" },
  { index: 2, name: "寅", range: "03:00~05:00" },
  { index: 3, name: "卯", range: "05:00~07:00" },
  { index: 4, name: "辰", range: "07:00~09:00" },
  { index: 5, name: "巳", range: "09:00~11:00" },
  { index: 6, name: "午", range: "11:00~13:00" },
  { index: 7, name: "未", range: "13:00~15:00" },
  { index: 8, name: "申", range: "15:00~17:00" },
  { index: 9, name: "酉", range: "17:00~19:00" },
  { index: 10, name: "戌", range: "19:00~21:00" },
  { index: 11, name: "亥", range: "21:00~23:00" }
] as const;

export class ProvidedTimeNoValidCandidateError extends Error {
  readonly code = "PROVIDED_TIME_NO_VALID_CANDIDATE";

  constructor(detail: string) {
    super(`PROVIDED_TIME_NO_VALID_CANDIDATE: ${detail}`);
    this.name = "ProvidedTimeNoValidCandidateError";
  }
}

function calendarKey(basis: CalendarBasis): string {
  if (basis === "solar") return "solar";
  return basis === "lunar_regular" ? "0-lunar_regular" : "1-lunar_leap";
}

function candidateId(
  record: PublicBirthRecordV2,
  resolution: ValidCalendarResolution,
  dayBoundary: Candidate["dayBoundary"]
): string {
  return `${record.caseId}:${record.providedTime.basis}:${dayBoundary}:calendar:${calendarKey(resolution.basis)}`;
}

function branchFor(localDateTime: LocalDateTime): Pick<Candidate, "earthlyBranch" | "ziSegment"> {
  const hour = localDateTime.hour();
  const index = hour === 23 || hour === 0 ? 0 : Math.floor((hour + 1) / 2);
  return {
    earthlyBranch: BRANCHES[index],
    ziSegment: hour === 23 ? "late" : hour === 0 ? "early" : null
  };
}

function makeCandidate(
  record: PublicBirthRecordV2,
  resolution: ValidCalendarResolution,
  sourceDateTime: LocalDateTime,
  dayBoundary: Candidate["dayBoundary"],
  preferred: boolean
): Candidate {
  const localDateTime = dayBoundary === "forward" ? sourceDateTime.plusDays(1) : sourceDateTime;
  return {
    id: candidateId(record, resolution, dayBoundary),
    basis: record.providedTime.basis,
    preferred,
    localDateTime: localDateTime.toString(),
    ...branchFor(localDateTime),
    dayBoundary,
    calendarResolutionId: resolution.id,
    calendarBasis: resolution.basis,
    warnings: []
  };
}

function candidatesForResolution(
  record: PublicBirthRecordV2,
  resolution: ValidCalendarResolution,
  ambiguousCalendar: boolean,
  issues: Issue[]
): Candidate[] {
  const sourceDateTime = LocalDateTime.parse(`${resolution.solarDate}T${record.providedTime.localTime}`);
  const late = sourceDateTime.hour() === 23;
  if (!late) {
    return [makeCandidate(record, resolution, sourceDateTime, "current", !ambiguousCalendar)];
  }
  if (record.policy.lateZi === "current_day") {
    return [makeCandidate(record, resolution, sourceDateTime, "current", !ambiguousCalendar)];
  }
  if (record.policy.lateZi === "next_day") {
    return [makeCandidate(record, resolution, sourceDateTime, "forward", !ambiguousCalendar)];
  }

  const current = makeCandidate(record, resolution, sourceDateTime, "current", false);
  const forward = makeCandidate(record, resolution, sourceDateTime, "forward", false);
  issues.push({
    code: "late_zi_ambiguity",
    severity: "blocking",
    message: "23 点晚子时同时保留当日与次日换日规则候选。",
    candidateIds: [current.id, forward.id]
  });
  return [current, forward];
}

export function normalizeProvidedTime(record: PublicBirthRecordV2): TimeEvidenceV2 {
  const parsedRecord = PublicBirthRecordV2Schema.parse(record);
  const sourceYear = Number(parsedRecord.calendar.date.slice(0, 4));
  if (sourceYear < 1900 || sourceYear > 2099) {
    throw new RangeError("出生日期必须在 1900–2099 范围内");
  }

  let calendarResolutions: ReturnType<typeof resolveCalendarResolutions>;
  try {
    calendarResolutions = resolveCalendarResolutions(parsedRecord);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "没有可用的历法口径";
    throw new ProvidedTimeNoValidCandidateError(detail);
  }
  const validResolutions = calendarResolutions.filter(
    (resolution): resolution is ValidCalendarResolution => (
      resolution.status === "valid" && resolution.solarDate !== null
    )
  );
  for (const resolution of validResolutions) {
    const year = Number(resolution.solarDate.slice(0, 4));
    if (year < 1900 || year > 2099) {
      throw new RangeError("出生日期必须在 1900–2099 范围内");
    }
  }
  if (validResolutions.length === 0) {
    throw new ProvidedTimeNoValidCandidateError("没有可用的历法口径");
  }

  const issues: Issue[] = [];
  const ambiguousCalendar = parsedRecord.calendar.leapMonth === "unknown";
  const candidates = validResolutions.flatMap((resolution) => (
    candidatesForResolution(parsedRecord, resolution, ambiguousCalendar, issues)
  ));

  if (ambiguousCalendar) {
    const hasInvalidAlternative = calendarResolutions.some((resolution) => resolution.status === "invalid");
    issues.push({
      code: hasInvalidAlternative ? "leap_month_alternative_invalid" : "leap_month_ambiguity",
      severity: "blocking",
      message: hasInvalidAlternative
        ? "农历闰月状态未确认，某一口径在该年份无有效日期；已保留无效转换证据，禁止静默裁决。"
        : "农历闰月状态未确认，普通月与闰月口径均有效，已并列保留候选。",
      candidateIds: candidates.map((candidate) => candidate.id)
    });
  }

  return TimeEvidenceV2Schema.parse({
    schemaVersion: "2.0.0",
    caseId: parsedRecord.caseId,
    sourceRecordFingerprint: sourceRecordFingerprint(parsedRecord),
    rulesetVersion: "CyberSaga-Provided-Time-v1",
    originalCalendar: parsedRecord.calendar,
    originalLocalTime: parsedRecord.providedTime.localTime,
    originalTimeBasis: parsedRecord.providedTime.basis,
    solarDate: ambiguousCalendar ? null : validResolutions[0].solarDate,
    calendarResolutions,
    candidates,
    issues
  });
}
