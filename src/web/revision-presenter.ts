import { PROVIDED_TIME_PRESENTATION } from "../shared/provided-time-presentation.js";

export interface PresentedRevisionInput {
  schemaVersion: "1.0.0" | "2.0.0";
  caseId: string;
  alias: string;
  gender: "男" | "女";
  calendar: string;
  localTime: string;
  timeBasis: string;
  timeStatement: string;
  location: string | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}格式无效`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}格式无效`);
  return value;
}

function gender(value: unknown): "男" | "女" {
  if (value !== "男" && value !== "女") throw new Error("性别格式无效");
  return value;
}

function calendarLabel(value: unknown): string {
  const calendar = record(value, "历法");
  const date = text(calendar.date, "日期");
  if (calendar.type === "solar") return `公历 ${date}`;
  if (calendar.type !== "lunar") throw new Error("历法格式无效");
  const suffix = calendar.leapMonth === true
    ? "（闰月）"
    : calendar.leapMonth === "unknown"
      ? "（闰月待核）"
      : "";
  return `农历 ${date}${suffix}`;
}

function providedPresentation(basis: unknown) {
  if (basis !== "apparent_solar_provided" && basis !== "civil_clock_provided") {
    throw new Error("时间口径格式无效");
  }
  return PROVIDED_TIME_PRESENTATION[basis];
}

export function timeBasisStatement(input: unknown): string {
  const source = record(input, "出生记录");
  if (source.schemaVersion === "2.0.0") {
    const providedTime = record(source.providedTime, "给定时间");
    return providedPresentation(providedTime.basis).statement;
  }
  if (source.schemaVersion === "1.0.0") {
    return "历史案例按已冻结的地点、时区与时间校正规则重放。";
  }
  throw new Error("不支持的出生记录版本");
}

export function presentRevisionInput(input: unknown): PresentedRevisionInput {
  const source = record(input, "出生记录");
  const common = {
    caseId: text(source.caseId, "案例编号"),
    alias: text(source.alias, "案例别名"),
    gender: gender(source.gender),
    calendar: calendarLabel(source.calendar)
  };
  if (source.schemaVersion === "2.0.0") {
    const providedTime = record(source.providedTime, "给定时间");
    const presentation = providedPresentation(providedTime.basis);
    return {
      schemaVersion: "2.0.0",
      ...common,
      localTime: text(providedTime.localTime, "出生时间"),
      timeBasis: presentation.label,
      timeStatement: presentation.statement,
      location: null
    };
  }
  if (source.schemaVersion === "1.0.0") {
    const birthTime = record(source.birthTime, "出生时间");
    const location = record(source.location, "地点");
    const locationLabel = text(location.label, "地点名称");
    const timeZone = text(location.timeZone, "时区");
    return {
      schemaVersion: "1.0.0",
      ...common,
      localTime: text(birthTime.localTime, "出生时间"),
      timeBasis: "历史地点与时区计算口径",
      timeStatement: timeBasisStatement(source),
      location: `${locationLabel} · ${timeZone}`
    };
  }
  throw new Error("不支持的出生记录版本");
}
