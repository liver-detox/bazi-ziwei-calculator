import { LUNAR_LEAP_MONTHS_1900_2099 } from "../shared/lunar-leap-months.generated.js";

export type ProvidedTimeGender = "" | "男" | "女";
export type ProvidedTimeBasis = "" | "apparent_solar_provided" | "civil_clock_provided";
export type ProvidedTimeSourceType =
  | "birth_certificate"
  | "hospital_record"
  | "family_memory"
  | "existing_chart"
  | "external_true_solar_tool"
  | "unknown";

export interface ProvidedTimeFormState {
  alias: string;
  privateName: string;
  gender: ProvidedTimeGender;
  calendarType: "solar" | "lunar";
  date: string;
  leapMonth: boolean | "unknown";
  localTime: string;
  timeBasis: ProvidedTimeBasis;
  precision: "minute" | "approximate" | "branch";
  sourceType: ProvidedTimeSourceType;
  sourceNote: string;
  birthplaceNote: string;
  lateZi: "candidates" | "current_day" | "next_day";
  targetYears: string;
}

export interface ProvidedTimeRequest {
  birthRecord: {
    schemaVersion: "2.0.0";
    caseId: string;
    alias: string;
    privateName?: string;
    gender: "男" | "女";
    calendar: {
      type: "solar" | "lunar";
      date: string;
      leapMonth: boolean | "unknown";
    };
    providedTime: {
      localTime: string;
      basis: Exclude<ProvidedTimeBasis, "">;
      precision: ProvidedTimeFormState["precision"];
      sourceType: ProvidedTimeSourceType;
      sourceNote?: string;
    };
    policy: { lateZi: ProvidedTimeFormState["lateZi"] };
  };
  targetYears: number[];
  workflowStatus: "review";
  privateContext?: { birthplaceNote: string };
}

const CASE_ID = /^CS-(\d{4})-(\d{3})$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export function emptyProvidedTimeForm(): ProvidedTimeFormState {
  return {
    alias: "",
    privateName: "",
    gender: "",
    calendarType: "solar",
    date: "",
    leapMonth: false,
    localTime: "",
    timeBasis: "",
    precision: "minute",
    sourceType: "unknown",
    sourceNote: "",
    birthplaceNote: "",
    lateZi: "candidates",
    targetYears: ""
  };
}

function fourDigitYear(value: number): string {
  if (!Number.isInteger(value) || value < 1900 || value > 2099) {
    throw new Error("出生年份必须在 1900 至 2099 之间");
  }
  return String(value);
}

export function nextAvailableCaseId(birthYear: number, existingCaseIds: readonly string[]): string {
  const year = fourDigitYear(birthYear);
  const used = new Set<number>();
  for (const caseId of existingCaseIds) {
    const match = CASE_ID.exec(caseId);
    if (match?.[1] === year) used.add(Number(match[2]));
  }
  for (let sequence = 1; sequence <= 999; sequence += 1) {
    if (!used.has(sequence)) return `CS-${year}-${String(sequence).padStart(3, "0")}`;
  }
  throw new Error(`${year} 年的案例编号已用完`);
}

function parsedDate(form: Pick<ProvidedTimeFormState, "date" | "calendarType">): {
  year: number;
  month: number;
  day: number;
} {
  if (form.date.trim() === "") throw new Error("请输入出生日期");
  const match = DATE.exec(form.date);
  if (match === null) throw new Error("出生日期必须使用 YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  fourDigitYear(year);
  if (form.calendarType === "solar") {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (
      candidate.getUTCFullYear() !== year
      || candidate.getUTCMonth() !== month - 1
      || candidate.getUTCDate() !== day
    ) {
      throw new Error("请输入有效的公历日期");
    }
  } else if (month < 1 || month > 12 || day < 1 || day > 30) {
    throw new Error("请输入有效的农历日期");
  }
  return { year, month, day };
}

export function parseTargetYearsInput(text: string, birthYear: number): number[] {
  const normalized = text.trim();
  if (normalized === "") return [];
  const tokens = normalized.split(/[\s,，、]+/u).filter(Boolean);
  if (tokens.some((token) => !/^\d{4}$/u.test(token))) {
    throw new Error("目标流年必须是四位年份，可用逗号、顿号或空格分隔");
  }
  const years = tokens.map(Number);
  if (years.some((year) => year < 1900 || year > 2099)) {
    throw new Error("目标流年必须在 1900 至 2099 之间");
  }
  if (new Set(years).size !== years.length) throw new Error("目标流年不能重复");
  if (years.some((year) => year < birthYear)) throw new Error("目标流年不能早于出生年份");
  if (years.length > 50) throw new Error("目标流年最多填写 50 个");
  return [...years].sort((left, right) => left - right);
}

export function shouldShowLeapMonthChoice(
  form: Pick<ProvidedTimeFormState, "calendarType" | "date">
): boolean {
  if (form.calendarType !== "lunar") return false;
  const match = DATE.exec(form.date);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2099) return false;
  return LUNAR_LEAP_MONTHS_1900_2099[year - 1900] === month;
}

export function shouldShowLateZiChoice(
  form: Pick<ProvidedTimeFormState, "localTime">
): boolean {
  return /^23:[0-5]\d$/u.test(form.localTime);
}

export function buildProvidedTimeRequest(
  form: ProvidedTimeFormState,
  options: { caseId: string }
): ProvidedTimeRequest {
  if (form.gender === "") throw new Error("请选择性别");
  const { year } = parsedDate(form);
  if (form.localTime.trim() === "") throw new Error("请输入出生时间");
  if (!LOCAL_TIME.test(form.localTime)) throw new Error("出生时间必须使用 HH:mm");
  if (form.timeBasis === "") throw new Error("请选择时间口径");
  if (!CASE_ID.test(options.caseId)) throw new Error("案例编号格式无效");

  const alias = form.alias.trim() || options.caseId;
  const privateName = form.privateName.trim();
  const sourceNote = form.sourceNote.trim();
  const birthplaceNote = form.birthplaceNote.trim();
  const targetYears = parseTargetYearsInput(form.targetYears, year);
  const leapMonth = form.calendarType === "lunar" && shouldShowLeapMonthChoice(form)
    ? form.leapMonth
    : false;

  return {
    birthRecord: {
      schemaVersion: "2.0.0",
      caseId: options.caseId,
      alias,
      ...(privateName === "" ? {} : { privateName }),
      gender: form.gender,
      calendar: { type: form.calendarType, date: form.date, leapMonth },
      providedTime: {
        localTime: form.localTime,
        basis: form.timeBasis,
        precision: form.precision,
        sourceType: form.sourceType,
        ...(sourceNote === "" ? {} : { sourceNote })
      },
      policy: { lateZi: form.lateZi }
    },
    targetYears,
    workflowStatus: "review",
    ...(birthplaceNote === "" ? {} : { privateContext: { birthplaceNote } })
  };
}
