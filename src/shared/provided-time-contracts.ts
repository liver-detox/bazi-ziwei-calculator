import { LocalDate } from "@js-joda/core";
import { z } from "zod";

const CASE_ID = z.string().regex(/^CS-\d{4}-\d{3}$/u, "caseId 必须符合 CS-YYYY-NNN");
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/u;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u;
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;

function isValidSolarDate(dateText: string): boolean {
  try {
    LocalDate.parse(dateText);
    return true;
  } catch {
    return false;
  }
}

export const ProvidedTimeBasisV1Schema = z.enum([
  "apparent_solar_provided",
  "civil_clock_provided"
]);

const CalendarV2Schema = z.object({
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

export const ProvidedTimeV1Schema = z.object({
  localTime: z.string().regex(LOCAL_TIME, "localTime 必须使用 HH:mm"),
  basis: ProvidedTimeBasisV1Schema,
  precision: z.enum(["minute", "approximate", "branch"]),
  sourceType: z.enum([
    "birth_certificate",
    "hospital_record",
    "family_memory",
    "existing_chart",
    "external_true_solar_tool",
    "unknown"
  ]),
  sourceNote: z.string().trim().min(1).optional()
}).strict();

const PublicProvidedTimeV1Schema = ProvidedTimeV1Schema.omit({ sourceNote: true }).strict();

const TimePolicyV2Schema = z.object({
  lateZi: z.enum(["candidates", "current_day", "next_day"])
}).strict();

export const BirthRecordV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  caseId: CASE_ID,
  alias: z.string().trim().min(1),
  privateName: z.string().trim().min(1).optional(),
  gender: z.enum(["男", "女"]),
  calendar: CalendarV2Schema,
  providedTime: ProvidedTimeV1Schema,
  policy: TimePolicyV2Schema
}).strict();

export const PublicBirthRecordV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  caseId: CASE_ID,
  alias: z.string().trim().min(1),
  gender: z.enum(["男", "女"]),
  calendar: CalendarV2Schema,
  providedTime: PublicProvidedTimeV1Schema,
  policy: TimePolicyV2Schema
}).strict();

const CalendarBasisV1Schema = z.enum(["solar", "lunar_regular", "lunar_leap"]);

const CalendarResolutionV2Schema = z.object({
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

const EarthlyBranchIndexV1Schema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3),
  z.literal(4), z.literal(5), z.literal(6), z.literal(7),
  z.literal(8), z.literal(9), z.literal(10), z.literal(11)
]);

const EarthlyBranchV1Schema = z.object({
  index: EarthlyBranchIndexV1Schema,
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
}).strict();

const ProvidedTimeCandidateV1Schema = z.object({
  id: z.string().min(1),
  basis: ProvidedTimeBasisV1Schema,
  preferred: z.boolean(),
  localDateTime: z.string().regex(LOCAL_DATE_TIME),
  earthlyBranch: EarthlyBranchV1Schema,
  ziSegment: z.enum(["early", "late"]).nullable(),
  dayBoundary: z.enum(["current", "forward"]),
  calendarResolutionId: z.string().min(1),
  calendarBasis: CalendarBasisV1Schema,
  warnings: z.array(z.string().min(1))
}).strict();

const ProvidedTimeIssueV1Schema = z.object({
  code: z.enum([
    "late_zi_ambiguity",
    "leap_month_ambiguity",
    "leap_month_alternative_invalid"
  ]),
  severity: z.enum(["warning", "blocking"]),
  message: z.string().min(1),
  candidateIds: z.array(z.string().min(1)).min(1)
}).strict();

export const TimeEvidenceV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  caseId: CASE_ID,
  sourceRecordFingerprint: z.string().regex(SHA256_REFERENCE),
  rulesetVersion: z.literal("CyberSaga-Provided-Time-v1"),
  originalCalendar: CalendarV2Schema,
  originalLocalTime: z.string().regex(LOCAL_TIME),
  originalTimeBasis: ProvidedTimeBasisV1Schema,
  solarDate: z.string().refine(isValidSolarDate, "solarDate 必须为合法公历日期").nullable(),
  calendarResolutions: z.array(CalendarResolutionV2Schema),
  candidates: z.array(ProvidedTimeCandidateV1Schema).min(1),
  issues: z.array(ProvidedTimeIssueV1Schema)
}).strict().superRefine((evidence, context) => {
  const resolutionById = new Map<string, typeof evidence.calendarResolutions[number]>();
  evidence.calendarResolutions.forEach((resolution, index) => {
    if (resolutionById.has(resolution.id)) {
      context.addIssue({ code: "custom", message: "历法口径 ID 必须唯一", path: ["calendarResolutions", index, "id"] });
    }
    resolutionById.set(resolution.id, resolution);
  });

  const candidateIds = new Set<string>();
  evidence.candidates.forEach((candidate, index) => {
    if (candidateIds.has(candidate.id)) {
      context.addIssue({ code: "custom", message: "候选 ID 必须唯一", path: ["candidates", index, "id"] });
    }
    candidateIds.add(candidate.id);
    if (candidate.basis !== evidence.originalTimeBasis) {
      context.addIssue({ code: "custom", message: "候选时间口径必须与原始输入一致", path: ["candidates", index, "basis"] });
    }
    const resolution = resolutionById.get(candidate.calendarResolutionId);
    if (resolution === undefined || resolution.status !== "valid") {
      context.addIssue({ code: "custom", message: "候选只能绑定存在且有效的历法口径", path: ["candidates", index, "calendarResolutionId"] });
    } else if (resolution.basis !== candidate.calendarBasis) {
      context.addIssue({ code: "custom", message: "候选历法口径必须与证据一致", path: ["candidates", index, "calendarBasis"] });
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

  if (evidence.originalCalendar.leapMonth === "unknown") {
    const bases = new Set(evidence.calendarResolutions.map((resolution) => resolution.basis));
    if (!bases.has("lunar_regular") || !bases.has("lunar_leap")) {
      context.addIssue({
        code: "custom",
        message: "闰月未确认时必须记录普通月与闰月两种口径",
        path: ["calendarResolutions"]
      });
    }
  }
});

export type ProvidedTimeBasisV1 = z.infer<typeof ProvidedTimeBasisV1Schema>;
export type ProvidedTimeV1 = z.infer<typeof ProvidedTimeV1Schema>;
export type BirthRecordV2 = z.infer<typeof BirthRecordV2Schema>;
export type PublicBirthRecordV2 = z.infer<typeof PublicBirthRecordV2Schema>;
export type ProvidedTimeCandidateV1 = z.infer<typeof ProvidedTimeCandidateV1Schema>;
export type TimeEvidenceV2 = z.infer<typeof TimeEvidenceV2Schema>;
