import "@js-joda/timezone";

import { LocalDate, ZoneRulesProvider } from "@js-joda/core";
import { z } from "zod";

import {
  BirthRecordV2Schema,
  TimeEvidenceV2Schema,
  type BirthRecordV2,
  type TimeEvidenceV2
} from "./provided-time-contracts.js";

import {
  clockConventionValidationIssues,
  explicitClockConventionProfile,
  locationRequiresClockConventionConfirmation
} from "./clock-convention.js";

export {
  EXPLICIT_CLOCK_CONVENTIONS_V1,
  explicitClockConventionProfile
} from "./clock-convention.js";

const SCHEMA_VERSION = z.literal("1.0.0");
const CASE_ID = z.string().regex(/^CS-\d{4}-\d{3}$/u, "caseId 必须符合 CS-YYYY-NNN");
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/u;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u;
const OFFSET = /^(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function isValidSolarDate(dateText: string): boolean {
  try {
    LocalDate.parse(dateText);
    return true;
  } catch {
    return false;
  }
}

function isValidIanaZone(zoneText: string): boolean {
  return ZoneRulesProvider.getAvailableZoneIds().includes(zoneText);
}

const CalendarV1Schema = z.object({
  type: z.enum(["solar", "lunar"]),
  date: z.string().regex(DATE_TEXT, "date 必须使用 YYYY-MM-DD"),
  leapMonth: z.union([z.boolean(), z.literal("unknown")])
}).strict().superRefine((calendar, context) => {
  const [, monthText, dayText] = calendar.date.split("-");
  const month = Number(monthText);
  const day = Number(dayText);
  const valid = calendar.type === "solar"
    ? isValidSolarDate(calendar.date)
    : month >= 1 && month <= 12 && day >= 1 && day <= 30;
  if (!valid) {
    context.addIssue({ code: "custom", message: "日历日期无效", path: ["date"] });
  }
  if (calendar.type === "solar" && calendar.leapMonth !== false) {
    context.addIssue({ code: "custom", message: "公历不能标记闰月", path: ["leapMonth"] });
  }
});

const BirthTimeV1Schema = z.object({
  localTime: z.string().regex(LOCAL_TIME, "localTime 必须使用 HH:mm"),
  precision: z.enum(["minute", "approximate", "branch"]),
  sourceType: z.enum([
    "birth_certificate",
    "hospital_record",
    "family_memory",
    "existing_chart",
    "unknown"
  ]),
  sourceNote: z.string().trim().min(1).optional()
}).strict();

const LocationV1Schema = z.object({
  label: z.string().trim().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/u, "countryCode 必须为 ISO 两位大写代码"),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180),
  timeZone: z.string().refine(isValidIanaZone, "timeZone 必须为已加载的 IANA 时区"),
  standardOffsetMinutes: z.number().int().min(-840).max(840).optional(),
  clockConvention: z.enum(["official", "beijing", "xinjiang", "unknown"]),
  coordinateSource: z.enum([
    "representative_city",
    "representative_with_longitude_override",
    "manual",
    "documented_exact",
    "unknown"
  ]).optional(),
  geoNamesReference: z.object({
    geonameId: z.number().int().positive(),
    snapshotVersion: z.literal("GeoNames-CN-major-cities-v1"),
    contentSha256: z.literal("bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d"),
    coordinateKind: z.literal("representative")
  }).strict().optional(),
  longitudeOverride: z.object({
    representativeLongitude: z.number().finite().min(-180).max(180),
    reason: z.literal("operator_override")
  }).strict().optional(),
  requiresClockConventionConfirmation: z.boolean().optional()
}).strict().superRefine((location, context) => {
  clockConventionValidationIssues(location).forEach((issue) => {
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: [issue.path]
    });
  });
  const usesGeoNames = location.coordinateSource === "representative_city"
    || location.coordinateSource === "representative_with_longitude_override";
  if (usesGeoNames && location.geoNamesReference === undefined) {
    context.addIssue({
      code: "custom",
      message: "城市代表点必须记录 GeoNames 快照引用",
      path: ["geoNamesReference"]
    });
  }
  if (location.geoNamesReference !== undefined && !usesGeoNames) {
    context.addIssue({
      code: "custom",
      message: "GeoNames 快照引用只适用于城市代表点",
      path: ["coordinateSource"]
    });
  }
  if (
    (location.coordinateSource === "representative_with_longitude_override")
    !== (location.longitudeOverride !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "人工覆盖经度必须保存代表点原经度",
      path: ["longitudeOverride"]
    });
  }
}).transform((location) => locationRequiresClockConventionConfirmation(location)
  ? { ...location, requiresClockConventionConfirmation: true as const }
  : location);

const TimePolicyV1Schema = z.object({
  trueSolar: z.enum(["compare", "civil_only", "apparent_primary"]),
  dst: z.enum(["iana", "standard_time", "unknown"]),
  lateZi: z.enum(["candidates", "current_day", "next_day"])
}).strict();

export const BirthRecordV1Schema = z.object({
  schemaVersion: SCHEMA_VERSION,
  caseId: CASE_ID,
  alias: z.string().trim().min(1),
  privateName: z.string().trim().min(1).optional(),
  gender: z.enum(["男", "女"]),
  calendar: CalendarV1Schema,
  birthTime: BirthTimeV1Schema,
  location: LocationV1Schema,
  policy: TimePolicyV1Schema
}).strict();

export type BirthRecordV1 = z.infer<typeof BirthRecordV1Schema>;

const TimezoneEngineV1Schema = z.object({
  corePackage: z.literal("@js-joda/core"),
  coreVersion: z.literal("6.1.0"),
  timezonePackage: z.literal("@js-joda/timezone"),
  timezoneVersion: z.literal("2.25.2"),
  tzdbVersion: z.literal("2026a"),
  buildFile: z.literal("dist/js-joda-timezone.esm.js"),
  buildSha256: z.literal("97f73005978d13a8b633964727bdfacbfaa4ae033768cc524aafb3e4b11dd6ec")
}).strict();

function minuteAndSecondEvidenceMatch(minutes: number | null, seconds: number | undefined): boolean {
  if (seconds === undefined) {
    return true;
  }
  if (minutes === null) {
    return false;
  }
  const secondsFromMinutes = minutes * 60;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(secondsFromMinutes), Math.abs(seconds)) * 8;
  return Math.abs(secondsFromMinutes - seconds) <= tolerance;
}

const TrueSolarCorrectionV1Schema = z.object({
  sourceCandidateId: z.string().min(1),
  clockLocalDateTime: z.string().regex(LOCAL_DATE_TIME),
  standardLocalDateTime: z.string().regex(LOCAL_DATE_TIME),
  dstRemovedMinutes: z.number().finite(),
  dstRemovedSeconds: z.number().int().optional(),
  longitude: z.number().finite().min(-180).max(180),
  standardMeridian: z.number().finite().min(-180).max(180),
  longitudeCorrectionMinutes: z.number().finite(),
  equationOfTimeMinutes: z.number().finite(),
  totalCorrectionMinutes: z.number().finite(),
  roundedTotalCorrectionMinutes: z.number().int(),
  adjustedLocalDateTime: z.string().regex(LOCAL_DATE_TIME)
}).strict().superRefine((correction, context) => {
  if (!minuteAndSecondEvidenceMatch(correction.dstRemovedMinutes, correction.dstRemovedSeconds)) {
    context.addIssue({
      code: "custom",
      message: "dstRemovedSeconds 必须与 dstRemovedMinutes 精确一致",
      path: ["dstRemovedSeconds"]
    });
  }
});

const CalendarBasisV1Schema = z.enum(["solar", "lunar_regular", "lunar_leap"]);

const CalendarResolutionV1Schema = z.object({
  id: z.string().min(1),
  basis: CalendarBasisV1Schema,
  status: z.enum(["valid", "invalid"]),
  sourceDate: z.string().regex(DATE_TEXT),
  solarDate: z.string().refine(isValidSolarDate).nullable(),
  note: z.string().min(1)
}).strict().superRefine((resolution, context) => {
  if ((resolution.status === "valid") !== (resolution.solarDate !== null)) {
    context.addIssue({
      code: "custom",
      message: "有效历法口径必须且只能携带公历日期",
      path: ["solarDate"]
    });
  }
});

const TimeCandidateV1Schema = z.object({
  id: z.string().min(1),
  basis: z.enum(["civil_iana", "civil_standard", "gap_before", "gap_after", "apparent_solar"]),
  preferred: z.boolean(),
  localDateTime: z.string().regex(LOCAL_DATE_TIME),
  instant: z.string().regex(INSTANT),
  offset: z.string().regex(OFFSET),
  standardOffset: z.string().regex(OFFSET).nullable(),
  dstMinutes: z.number().finite().nullable(),
  dstSeconds: z.number().int().optional(),
  earthlyBranch: z.object({
    index: z.number().int().min(0).max(11),
    name: z.enum(["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]),
    range: z.enum([
      "23:00~01:00",
      "01:00~03:00",
      "03:00~05:00",
      "05:00~07:00",
      "07:00~09:00",
      "09:00~11:00",
      "11:00~13:00",
      "13:00~15:00",
      "15:00~17:00",
      "17:00~19:00",
      "19:00~21:00",
      "21:00~23:00"
    ])
  }).strict(),
  ziSegment: z.enum(["early", "late"]).nullable(),
  dayBoundary: z.enum(["current", "forward"]),
  calendarResolutionId: z.string().min(1).optional(),
  calendarBasis: CalendarBasisV1Schema.optional(),
  trueSolarCorrection: TrueSolarCorrectionV1Schema.nullable(),
  warnings: z.array(z.string().min(1))
}).strict().superRefine((candidate, context) => {
  if (!minuteAndSecondEvidenceMatch(candidate.dstMinutes, candidate.dstSeconds)) {
    context.addIssue({
      code: "custom",
      message: "dstSeconds 必须与 dstMinutes 精确一致",
      path: ["dstSeconds"]
    });
  }
});

const TimeIssueV1Schema = z.object({
  code: z.enum([
    "dst_overlap",
    "dst_gap",
    "dst_unknown",
    "true_solar_branch_change",
    "true_solar_same_branch",
    "late_zi_ambiguity",
    "leap_month_ambiguity",
    "leap_month_alternative_invalid",
    "historical_uncertainty",
    "future_provisional",
    "standard_offset_unresolved"
  ]),
  severity: z.enum(["warning", "blocking"]),
  message: z.string().min(1),
  candidateIds: z.array(z.string().min(1)).min(1)
}).strict();

export const TimeEvidenceV1Schema = z.object({
  schemaVersion: SCHEMA_VERSION,
  caseId: CASE_ID,
  sourceRecordFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  rulesetVersion: z.literal("CyberSaga-Time-v1"),
  originalCalendar: CalendarV1Schema,
  originalLocalTime: z.string().regex(LOCAL_TIME),
  solarDate: z.string().refine(isValidSolarDate, "solarDate 必须为合法公历日期").nullable(),
  calendarResolutions: z.array(CalendarResolutionV1Schema).default([]),
  timeZone: z.string().refine(isValidIanaZone),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180),
  clockConvention: z.enum(["official", "beijing", "xinjiang", "unknown"]),
  standardOffsetMinutes: z.number().int().min(-840).max(840).nullable(),
  standardOffsetSource: z.enum(["fixed_zone", "ruleset", "record", "clock_convention", "unresolved"]),
  standardOffsetRule: z.object({
    rulesetVersion: z.literal("CyberSaga-StandardOffset-v1"),
    ruleId: z.string().min(1),
    validFrom: z.string().refine(isValidSolarDate),
    validTo: z.string().refine(isValidSolarDate),
    source: z.string().min(1)
  }).strict().nullable(),
  timezoneEngine: TimezoneEngineV1Schema,
  candidates: z.array(TimeCandidateV1Schema).min(1),
  issues: z.array(TimeIssueV1Schema)
}).strict().superRefine((evidence, context) => {
  const conventionProfile = explicitClockConventionProfile(evidence.clockConvention);
  if (conventionProfile !== undefined && evidence.timeZone !== conventionProfile.timeZone) {
    context.addIssue({
      code: "custom",
      message: `${evidence.clockConvention} 钟表口径证据必须使用 ${conventionProfile.timeZone}`,
      path: ["timeZone"]
    });
  }
  if (
    conventionProfile !== undefined
    && evidence.standardOffsetMinutes !== null
    && evidence.standardOffsetMinutes !== conventionProfile.standardOffsetMinutes
  ) {
    context.addIssue({
      code: "custom",
      message: `${evidence.clockConvention} 钟表口径证据的标准偏移必须为 ${conventionProfile.standardOffsetMinutes} 分钟`,
      path: ["standardOffsetMinutes"]
    });
  }
  const candidateIds = new Set<string>();
  const resolutionById = new Map<string, typeof evidence.calendarResolutions[number]>();
  evidence.calendarResolutions.forEach((resolution, resolutionIndex) => {
    if (resolutionById.has(resolution.id)) {
      context.addIssue({
        code: "custom",
        message: "历法口径 ID 必须唯一",
        path: ["calendarResolutions", resolutionIndex, "id"]
      });
      return;
    }
    resolutionById.set(resolution.id, resolution);
  });
  evidence.candidates.forEach((candidate, candidateIndex) => {
    if (candidateIds.has(candidate.id)) {
      context.addIssue({
        code: "custom",
        message: "候选 ID 必须唯一",
        path: ["candidates", candidateIndex, "id"]
      });
    }
    candidateIds.add(candidate.id);
    const hasResolutionId = candidate.calendarResolutionId !== undefined;
    const hasCalendarBasis = candidate.calendarBasis !== undefined;
    if (hasResolutionId !== hasCalendarBasis) {
      context.addIssue({
        code: "custom",
        message: "候选历法口径 ID 与口径类型必须成对出现",
        path: ["candidates", candidateIndex]
      });
    }
    const resolution = candidate.calendarResolutionId === undefined
      ? undefined
      : resolutionById.get(candidate.calendarResolutionId);
    if (candidate.calendarResolutionId !== undefined && resolution === undefined) {
      context.addIssue({
        code: "custom",
        message: "候选引用的历法口径不存在",
        path: ["candidates", candidateIndex, "calendarResolutionId"]
      });
    }
    if (resolution?.status === "invalid") {
      context.addIssue({
        code: "custom",
        message: "候选只能绑定可成功转换的历法口径",
        path: ["candidates", candidateIndex, "calendarResolutionId"]
      });
    }
    if (resolution !== undefined && candidate.calendarBasis !== undefined && candidate.calendarBasis !== resolution.basis) {
      context.addIssue({
        code: "custom",
        message: "候选历法口径类型必须与所引用证据一致",
        path: ["candidates", candidateIndex, "calendarBasis"]
      });
    }
  });

  evidence.issues.forEach((issue, issueIndex) => {
    issue.candidateIds.forEach((candidateId, referenceIndex) => {
      if (!candidateIds.has(candidateId)) {
        context.addIssue({
          code: "custom",
          message: "issue 引用的候选 ID 不存在",
          path: ["issues", issueIndex, "candidateIds", referenceIndex]
        });
      }
    });
  });

  evidence.candidates.forEach((candidate, candidateIndex) => {
    const sourceCandidateId = candidate.trueSolarCorrection?.sourceCandidateId;
    if (sourceCandidateId !== undefined && !candidateIds.has(sourceCandidateId)) {
      context.addIssue({
        code: "custom",
        message: "真太阳时源候选 ID 不存在",
        path: ["candidates", candidateIndex, "trueSolarCorrection", "sourceCandidateId"]
      });
    }
  });

  if (evidence.originalCalendar.leapMonth === "unknown") {
    const bases = new Set(evidence.calendarResolutions.map((resolution) => resolution.basis));
    if (!bases.has("lunar_regular") || !bases.has("lunar_leap")) {
      context.addIssue({
        code: "custom",
        message: "闰月未确认时必须记录普通月与闰月两种口径",
        path: ["calendarResolutions"]
      });
    }
    evidence.candidates.forEach((candidate, candidateIndex) => {
      if (candidate.calendarResolutionId === undefined || candidate.calendarBasis === undefined) {
        context.addIssue({
          code: "custom",
          message: "闰月未确认的候选必须绑定明确历法口径",
          path: ["candidates", candidateIndex]
        });
      }
    });
  }
});

export type TimeEvidenceV1 = z.infer<typeof TimeEvidenceV1Schema>;

export const BirthRecordAnySchema = z.discriminatedUnion("schemaVersion", [
  BirthRecordV1Schema,
  BirthRecordV2Schema
]);
export const TimeEvidenceAnySchema = z.discriminatedUnion("schemaVersion", [
  TimeEvidenceV1Schema,
  TimeEvidenceV2Schema
]);

export type BirthRecordAny = BirthRecordV1 | BirthRecordV2;
export type TimeEvidenceAny = TimeEvidenceV1 | TimeEvidenceV2;

export {
  BirthRecordV2Schema,
  PublicBirthRecordV2Schema,
  ProvidedTimeBasisV1Schema,
  ProvidedTimeV1Schema,
  TimeEvidenceV2Schema
} from "./provided-time-contracts.js";
export type {
  BirthRecordV2,
  ProvidedTimeBasisV1,
  ProvidedTimeCandidateV1,
  ProvidedTimeV1,
  PublicBirthRecordV2,
  TimeEvidenceV2
} from "./provided-time-contracts.js";

// These type-only exports deliberately point at the production contracts.
// Their runtime schemas stay beside the owning chart/audit modules to avoid a
// runtime dependency cycle through BirthRecordV1 and TimeEvidenceV1.
export type { CandidateDualChartV1 as ChartBundleV1 } from "../core/charts/types.js";
export type { AuditReportV1 } from "../core/audit/index.js";
