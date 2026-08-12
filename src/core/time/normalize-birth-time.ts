import "@js-joda/timezone";

import {
  LocalDateTime,
  ZoneId,
  ZoneOffset,
  type ZoneRules
} from "@js-joda/core";
import {
  BirthRecordV1Schema,
  TimeEvidenceV1Schema,
  explicitClockConventionProfile,
  type BirthRecordV1,
  type TimeEvidenceV1
} from "../../shared/contracts.js";
import {
  STANDARD_OFFSET_RULESET_VERSION,
  findStandardOffsetRule,
  type StandardOffsetRuleV1
} from "./standard-offset-ruleset.js";
import { TIMEZONE_ENGINE_MANIFEST } from "./timezone-manifest.js";
import { sourceRecordFingerprint } from "./source-record-fingerprint.js";
import {
  resolveCalendarResolutions,
  type CalendarBasis,
  type ValidCalendarResolution
} from "./calendar-resolution.js";

type TimeCandidate = TimeEvidenceV1["candidates"][number];
type TimeIssue = TimeEvidenceV1["issues"][number];
type CandidateBasis = TimeCandidate["basis"];
function calendarDiscriminator(basis: CalendarBasis, ambiguous: boolean): string | undefined {
  if (!ambiguous) return undefined;
  return basis === "lunar_regular" ? "0-lunar_regular" : "1-lunar_leap";
}

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

function fourDecimals(value: number): number {
  return Number(value.toFixed(4));
}

function offsetKey(offset: ZoneOffset): string {
  return offset.toString().replace(":", "").replace("Z", "+0000");
}

function candidateId(
  caseId: string,
  basis: CandidateBasis,
  offset: ZoneOffset,
  dayBoundary: TimeCandidate["dayBoundary"],
  calendarDiscriminator?: string,
  sourceCandidateId?: string
): string {
  const calendarSuffix = calendarDiscriminator === undefined ? "" : `:calendar:${calendarDiscriminator}`;
  const sourceSuffix = sourceCandidateId === undefined ? "" : `:from:${sourceCandidateId}`;
  return `${caseId}:${basis}:${offsetKey(offset)}:${dayBoundary}${calendarSuffix}${sourceSuffix}`;
}

function branchFor(localDateTime: LocalDateTime): Pick<TimeCandidate, "earthlyBranch" | "ziSegment"> {
  const hour = localDateTime.hour();
  const index = hour === 23 || hour === 0 ? 0 : Math.floor((hour + 1) / 2);
  return {
    earthlyBranch: BRANCHES[index],
    ziSegment: hour === 23 ? "late" : hour === 0 ? "early" : null
  };
}

function makeCandidate(input: {
  caseId: string;
  basis: CandidateBasis;
  localDateTime: LocalDateTime;
  offset: ZoneOffset;
  standardOffset: ZoneOffset | null;
  preferred: boolean;
  warnings?: string[];
  instant?: string;
  sourceCandidateId?: string;
  trueSolarCorrection?: TimeCandidate["trueSolarCorrection"];
  calendarResolution: ValidCalendarResolution;
  calendarDiscriminator?: string;
}): TimeCandidate {
  const dayBoundary = "current" as const;
  const dstSeconds = input.standardOffset === null
    ? null
    : input.offset.totalSeconds() - input.standardOffset.totalSeconds();
  return {
    id: candidateId(
      input.caseId,
      input.basis,
      input.offset,
      dayBoundary,
      input.calendarDiscriminator,
      input.sourceCandidateId
    ),
    basis: input.basis,
    preferred: input.preferred,
    localDateTime: input.localDateTime.toString(),
    instant: input.instant ?? input.localDateTime.toInstant(input.offset).toString(),
    offset: input.offset.toString(),
    standardOffset: input.standardOffset?.toString() ?? null,
    dstMinutes: dstSeconds === null ? null : dstSeconds / 60,
    ...(dstSeconds !== null && dstSeconds % 60 !== 0 ? { dstSeconds } : {}),
    ...branchFor(input.localDateTime),
    dayBoundary,
    calendarResolutionId: input.calendarResolution.id,
    calendarBasis: input.calendarResolution.basis,
    trueSolarCorrection: input.trueSolarCorrection ?? null,
    warnings: input.warnings ?? []
  };
}

function resolveStandardOffset(
  record: BirthRecordV1,
  rules: ZoneRules,
  localDateTime: LocalDateTime,
  solarDate: string
): {
  offset: ZoneOffset | null;
  minutes: number | null;
  source: TimeEvidenceV1["standardOffsetSource"];
  rule: StandardOffsetRuleV1 | null;
} {
  const suppliedMinutes = record.location.standardOffsetMinutes;

  if (rules.isFixedOffset()) {
    const validOffsets = rules.validOffsets(localDateTime);
    if (validOffsets.length !== 1 || validOffsets[0].totalSeconds() % 60 !== 0) {
      throw new Error(`STANDARD_OFFSET_UNRESOLVED: ${record.location.timeZone} 固定偏移无法以整分钟表示`);
    }
    const fixedMinutes = validOffsets[0].totalSeconds() / 60;
    if (suppliedMinutes !== undefined && suppliedMinutes !== fixedMinutes) {
      throw new Error(
        `STANDARD_OFFSET_CONFLICT: ${record.location.timeZone} 固定偏移为 ${fixedMinutes} 分钟，与输入 ${suppliedMinutes} 分钟冲突`
      );
    }
    return { offset: validOffsets[0], minutes: fixedMinutes, source: "fixed_zone", rule: null };
  }

  const rule = findStandardOffsetRule(record.location.timeZone, solarDate);
  if (rule !== undefined) {
    if (suppliedMinutes !== undefined && suppliedMinutes !== rule.standardOffsetMinutes) {
      throw new Error(
        `STANDARD_OFFSET_CONFLICT: ${record.location.timeZone} 规则集偏移为 ${rule.standardOffsetMinutes} 分钟，与输入 ${suppliedMinutes} 分钟冲突`
      );
    }
    return {
      offset: ZoneOffset.ofTotalSeconds(rule.standardOffsetMinutes * 60),
      minutes: rule.standardOffsetMinutes,
      source: "ruleset",
      rule
    };
  }

  if (suppliedMinutes !== undefined) {
    return {
      offset: ZoneOffset.ofTotalSeconds(suppliedMinutes * 60),
      minutes: suppliedMinutes,
      source: "record",
      rule: null
    };
  }

  const conventionProfile = explicitClockConventionProfile(record.location.clockConvention);
  if (conventionProfile !== undefined && conventionProfile.timeZone === record.location.timeZone) {
    return {
      offset: ZoneOffset.ofTotalSeconds(conventionProfile.standardOffsetMinutes * 60),
      minutes: conventionProfile.standardOffsetMinutes,
      source: "clock_convention",
      rule: null
    };
  }

  return { offset: null, minutes: null, source: "unresolved", rule: null };
}

function ianaCandidates(
  caseId: string,
  localDateTime: LocalDateTime,
  rules: ZoneRules,
  standardOffset: ZoneOffset | null,
  preferred: boolean,
  issues: TimeIssue[],
  calendarResolution: ValidCalendarResolution,
  calendarDiscriminatorValue?: string
): TimeCandidate[] {
  const validOffsets = rules.validOffsets(localDateTime);
  if (validOffsets.length > 0) {
    const candidates = validOffsets.map((offset) => makeCandidate({
      caseId,
      basis: "civil_iana",
      localDateTime,
      offset,
      standardOffset,
      preferred,
      calendarResolution,
      calendarDiscriminator: calendarDiscriminatorValue
    }));
    if (validOffsets.length === 2) {
      issues.push({
        code: "dst_overlap",
        severity: "blocking",
        message: "当地时间落在夏令时重复区间，两个 UTC 偏移都有效。",
        candidateIds: candidates.map((candidate) => candidate.id)
      });
    }
    return candidates;
  }

  const transition = rules.transition(localDateTime);
  if (transition === null || !transition.isGap()) {
    throw new Error("时区规则返回了无法解释的当地时间空白");
  }
  const gapMinutes = transition.durationSeconds() / 60;
  const before = makeCandidate({
    caseId,
    basis: "gap_before",
    localDateTime: localDateTime.minusMinutes(gapMinutes),
    offset: transition.offsetBefore(),
    standardOffset,
    preferred,
    calendarResolution,
    calendarDiscriminator: calendarDiscriminatorValue,
    warnings: ["dst_gap_corrected_before"]
  });
  const after = makeCandidate({
    caseId,
    basis: "gap_after",
    localDateTime: localDateTime.plusMinutes(gapMinutes),
    offset: transition.offsetAfter(),
    standardOffset,
    preferred,
    calendarResolution,
    calendarDiscriminator: calendarDiscriminatorValue,
    warnings: ["dst_gap_corrected_after"]
  });
  issues.push({
    code: "dst_gap",
    severity: "blocking",
    message: "当地时间落在夏令时跳时空白，已明确保留向前与向后纠偏候选。",
    candidateIds: [before.id, after.id]
  });
  return [before, after];
}

function equationOfTimeMinutes(localDateTime: LocalDateTime): number {
  const dayOfYear = localDateTime.toLocalDate().dayOfYear();
  const hour = localDateTime.hour() + localDateTime.minute() / 60 + localDateTime.second() / 3600;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hour - 12) / 24);
  return 229.18 * (
    0.000075
    + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma)
  );
}

function apparentCandidate(
  record: BirthRecordV1,
  civil: TimeCandidate,
  standardOffset: ZoneOffset,
  issues: TimeIssue[],
  calendarResolution: ValidCalendarResolution,
  calendarDiscriminatorValue?: string
): TimeCandidate {
  if (civil.dstMinutes === null) {
    throw new Error("STANDARD_OFFSET_UNRESOLVED: 真太阳时需要标准偏移");
  }
  const clockLocalDateTime = LocalDateTime.parse(civil.localDateTime);
  const dstRemovedSeconds = civil.dstSeconds ?? Math.round(civil.dstMinutes * 60);
  const dstRemovedMinutes = dstRemovedSeconds / 60;
  const standardLocalDateTime = clockLocalDateTime.minusSeconds(dstRemovedSeconds);
  const standardMeridian = standardOffset.totalSeconds() / 240;
  const longitudeCorrection = 4 * (record.location.longitude - standardMeridian);
  const equationOfTime = equationOfTimeMinutes(standardLocalDateTime);
  const totalCorrection = -dstRemovedMinutes + longitudeCorrection + equationOfTime;
  const roundedTotalCorrection = Math.round(totalCorrection);
  const adjusted = clockLocalDateTime.plusMinutes(roundedTotalCorrection);
  const trueSolarCorrection: NonNullable<TimeCandidate["trueSolarCorrection"]> = {
    sourceCandidateId: civil.id,
    clockLocalDateTime: clockLocalDateTime.toString(),
    standardLocalDateTime: standardLocalDateTime.toString(),
    dstRemovedMinutes,
    ...(dstRemovedSeconds % 60 !== 0 ? { dstRemovedSeconds } : {}),
    longitude: record.location.longitude,
    standardMeridian: fourDecimals(standardMeridian),
    longitudeCorrectionMinutes: fourDecimals(longitudeCorrection),
    equationOfTimeMinutes: fourDecimals(equationOfTime),
    totalCorrectionMinutes: fourDecimals(totalCorrection),
    roundedTotalCorrectionMinutes: roundedTotalCorrection,
    adjustedLocalDateTime: adjusted.toString()
  };
  const apparent = makeCandidate({
    caseId: record.caseId,
    basis: "apparent_solar",
    localDateTime: adjusted,
    offset: standardOffset,
    standardOffset,
    instant: civil.instant,
    preferred: record.calendar.leapMonth !== "unknown" && record.policy.trueSolar === "apparent_primary",
    sourceCandidateId: civil.id,
    trueSolarCorrection,
    calendarResolution,
    calendarDiscriminator: calendarDiscriminatorValue
  });
  const branchChanged = civil.earthlyBranch.index !== apparent.earthlyBranch.index;
  issues.push({
    code: branchChanged ? "true_solar_branch_change" : "true_solar_same_branch",
    severity: branchChanged ? "blocking" : "warning",
    message: branchChanged
      ? "真太阳时校正改变了时支，必须保留双候选并人工复核。"
      : "真太阳时校正未改变时支，仍保留校正证据。",
    candidateIds: [civil.id, apparent.id]
  });
  return apparent;
}

function expandLateZi(
  record: BirthRecordV1,
  candidates: TimeCandidate[],
  issues: TimeIssue[]
): TimeCandidate[] {
  const expanded: TimeCandidate[] = [];
  const replacements = new Map<string, string[]>();

  for (const candidate of candidates) {
    if (candidate.ziSegment !== "late") {
      expanded.push(candidate);
      replacements.set(candidate.id, [candidate.id]);
      continue;
    }

    const makeBoundaryCandidate = (dayBoundary: TimeCandidate["dayBoundary"]): TimeCandidate => {
      const sourceLocal = LocalDateTime.parse(candidate.localDateTime);
      const localDateTime = dayBoundary === "forward" ? sourceLocal.plusDays(1) : sourceLocal;
      const offset = ZoneOffset.of(candidate.offset);
      const sourceCandidateIds = candidate.trueSolarCorrection === null
        ? undefined
        : replacements.get(candidate.trueSolarCorrection.sourceCandidateId);
      const boundarySourceCandidateId = sourceCandidateIds?.find((id) => id.includes(`:${dayBoundary}`))
        ?? sourceCandidateIds?.[0]
        ?? candidate.trueSolarCorrection?.sourceCandidateId;
      return {
        ...candidate,
        id: candidateId(
          record.caseId,
          candidate.basis,
          offset,
          dayBoundary,
          candidate.calendarBasis === undefined
            ? undefined
            : calendarDiscriminator(candidate.calendarBasis, record.calendar.leapMonth === "unknown"),
          candidate.basis === "apparent_solar" ? boundarySourceCandidateId : undefined
        ),
        localDateTime: localDateTime.toString(),
        dayBoundary,
        trueSolarCorrection: candidate.trueSolarCorrection === null
          ? null
          : {
            ...candidate.trueSolarCorrection,
            sourceCandidateId: boundarySourceCandidateId ?? candidate.trueSolarCorrection.sourceCandidateId
          }
      };
    };

    if (record.policy.lateZi === "current_day") {
      const current = makeBoundaryCandidate("current");
      expanded.push(current);
      replacements.set(candidate.id, [current.id]);
      continue;
    }
    if (record.policy.lateZi === "next_day") {
      const forward = makeBoundaryCandidate("forward");
      expanded.push(forward);
      replacements.set(candidate.id, [forward.id]);
      continue;
    }

    const current = makeBoundaryCandidate("current");
    const forward = makeBoundaryCandidate("forward");
    expanded.push(current, forward);
    replacements.set(candidate.id, [current.id, forward.id]);
    issues.push({
      code: "late_zi_ambiguity",
      severity: "blocking",
      message: "23 点晚子时同时保留当日与次日换日规则候选。",
      candidateIds: [current.id, forward.id]
    });
  }

  for (const issue of issues) {
    issue.candidateIds = [...new Set(issue.candidateIds.flatMap((id) => replacements.get(id) ?? [id]))];
  }
  return expanded;
}

function addPeriodIssue(
  issues: TimeIssue[],
  candidates: TimeCandidate[],
  code: "historical_uncertainty" | "future_provisional"
): void {
  const historical = code === "historical_uncertainty";
  issues.push({
    code,
    severity: "warning",
    message: historical
      ? "1970 年前的时区历史记录存在额外不确定性。"
      : "该出生年份晚于 tzdb 2026a 发布年，未来时区规则为暂定。",
    candidateIds: candidates.map((candidate) => candidate.id)
  });
  for (const candidate of candidates) {
    candidate.warnings.push(code);
  }
}

export function normalizeBirthTime(record: BirthRecordV1): TimeEvidenceV1 {
  const parsedRecord = BirthRecordV1Schema.parse(record);
  const calendarResolutions = resolveCalendarResolutions(parsedRecord);
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

  const rules = ZoneId.of(parsedRecord.location.timeZone).rules();
  const issues: TimeIssue[] = [];
  const candidates: TimeCandidate[] = [];
  const standardOffsetEvidenceByResolution: Array<ReturnType<typeof resolveStandardOffset>> = [];
  const ambiguousCalendar = parsedRecord.calendar.leapMonth === "unknown";

  for (const resolution of validResolutions) {
    const resolutionIssues: TimeIssue[] = [];
    const clockLocalDateTime = LocalDateTime.parse(
      `${resolution.solarDate}T${parsedRecord.birthTime.localTime}`
    );
    const standardOffsetEvidence = resolveStandardOffset(
      parsedRecord,
      rules,
      clockLocalDateTime,
      resolution.solarDate
    );
    standardOffsetEvidenceByResolution.push(standardOffsetEvidence);
    const standardOffset = standardOffsetEvidence.offset;
    const discriminator = calendarDiscriminator(resolution.basis, ambiguousCalendar);
    const civilPreferred = !ambiguousCalendar && parsedRecord.policy.trueSolar !== "apparent_primary";

    let civilCandidates: TimeCandidate[];
    if (parsedRecord.policy.dst === "standard_time") {
      if (standardOffset === null) {
        throw new Error(
          `STANDARD_OFFSET_UNRESOLVED: ${parsedRecord.location.timeZone} 不在 ${STANDARD_OFFSET_RULESET_VERSION} 且未提供补充证据`
        );
      }
      civilCandidates = [makeCandidate({
        caseId: parsedRecord.caseId,
        basis: "civil_standard",
        localDateTime: clockLocalDateTime,
        offset: standardOffset,
        standardOffset,
        preferred: civilPreferred,
        calendarResolution: resolution,
        calendarDiscriminator: discriminator
      })];
    } else {
      civilCandidates = ianaCandidates(
        parsedRecord.caseId,
        clockLocalDateTime,
        rules,
        standardOffset,
        civilPreferred,
        resolutionIssues,
        resolution,
        discriminator
      );
      if (parsedRecord.policy.dst === "unknown") {
        if (standardOffset !== null) {
          const standardCandidate = makeCandidate({
            caseId: parsedRecord.caseId,
            basis: "civil_standard",
            localDateTime: clockLocalDateTime,
            offset: standardOffset,
            standardOffset,
            preferred: civilPreferred,
            calendarResolution: resolution,
            calendarDiscriminator: discriminator
          });
          if (!civilCandidates.some((candidate) => (
            candidate.localDateTime === standardCandidate.localDateTime
            && candidate.offset === standardCandidate.offset
          ))) {
            civilCandidates.push(standardCandidate);
          }
        }
        resolutionIssues.push({
          code: "dst_unknown",
          severity: "blocking",
          message: standardOffset === null
            ? "出生记录无法确认是否已采用夏令时，且标准偏移未解析；仅保留 IANA 民用时候选。"
            : "出生记录无法确认是否已采用夏令时，已保留 IANA 民用时与标准时口径。",
          candidateIds: civilCandidates.map((candidate) => candidate.id)
        });
      }
    }

    if (standardOffset === null) {
      resolutionIssues.push({
        code: "standard_offset_unresolved",
        severity: "blocking",
        message: `时区 ${parsedRecord.location.timeZone} 不在 ${STANDARD_OFFSET_RULESET_VERSION}，且未提供标准偏移补充证据；已保留 IANA 民用候选并跳过标准时/真太阳时派生。`,
        candidateIds: civilCandidates.map((candidate) => candidate.id)
      });
    }

    let resolutionCandidates = parsedRecord.policy.trueSolar === "civil_only" || standardOffset === null
      ? civilCandidates
      : civilCandidates.flatMap((civil) => [
        civil,
        apparentCandidate(
          parsedRecord,
          civil,
          standardOffset,
          resolutionIssues,
          resolution,
          discriminator
        )
      ]);
    resolutionCandidates = expandLateZi(parsedRecord, resolutionCandidates, resolutionIssues);
    const year = Number(resolution.solarDate.slice(0, 4));
    if (year <= 1969) addPeriodIssue(resolutionIssues, resolutionCandidates, "historical_uncertainty");
    if (year > 2026) addPeriodIssue(resolutionIssues, resolutionCandidates, "future_provisional");
    candidates.push(...resolutionCandidates);
    issues.push(...resolutionIssues);
  }

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

  const standardOffsetEvidence = standardOffsetEvidenceByResolution[0];
  if (standardOffsetEvidence === undefined) {
    throw new Error("农历历法口径没有可计算候选");
  }
  const solarDate = ambiguousCalendar ? null : validResolutions[0].solarDate;

  return TimeEvidenceV1Schema.parse({
    schemaVersion: "1.0.0",
    caseId: parsedRecord.caseId,
    sourceRecordFingerprint: sourceRecordFingerprint(parsedRecord),
    rulesetVersion: "CyberSaga-Time-v1",
    originalCalendar: parsedRecord.calendar,
    originalLocalTime: parsedRecord.birthTime.localTime,
    solarDate,
    calendarResolutions,
    timeZone: parsedRecord.location.timeZone,
    latitude: parsedRecord.location.latitude,
    longitude: parsedRecord.location.longitude,
    clockConvention: parsedRecord.location.clockConvention,
    standardOffsetMinutes: standardOffsetEvidence.minutes,
    standardOffsetSource: standardOffsetEvidence.source,
    standardOffsetRule: standardOffsetEvidence.rule === null
      ? null
      : {
        rulesetVersion: STANDARD_OFFSET_RULESET_VERSION,
        ruleId: standardOffsetEvidence.rule.ruleId,
        validFrom: standardOffsetEvidence.rule.validFrom,
        validTo: standardOffsetEvidence.rule.validTo,
        source: standardOffsetEvidence.rule.source
      },
    timezoneEngine: TIMEZONE_ENGINE_MANIFEST,
    candidates,
    issues
  });
}
