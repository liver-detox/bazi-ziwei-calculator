import { LocalDate } from "@js-joda/core";

import type { ZiweiChartV1, ZiweiPalace } from "../core/charts/types.js";
import { resolveZiweiYearlyOverlay } from "./chart-display.js";
import { SPRING_FESTIVAL_DATES_1900_2099 } from "./spring-festival-dates.generated.js";

export const ZIWEI_DECADAL_BOUNDARY_NOTE = "交限按 normal 农历正月初一年界与已保存的虚岁大限范围确定，只说明该规则下的运限归属。7 月 1 日是年度代表盘取样日，不是交限日，也不代表现实事件发生。";
export const ZIWEI_DECADAL_BOUNDARY_UNAVAILABLE = "紫微交限日期不可用（旧版资料未知或不一致）：缺少可核对的日期、大限资料，或不符合锁定年界规则；不猜测交限日期。";

export interface ZiweiDecadalAssignment {
  kind: "decadal" | "childhood";
  startAge: number;
  endAge: number;
  palaceIndex: number;
  natalPalace: string;
  earthlyBranch: string;
  ganZhi: string;
}

export type ZiweiDecadalBoundary =
  | { status: "unselected" }
  | { status: "unavailable" }
  | { status: "before_birth" }
  | { status: "changed" | "unchanged"; targetYear: number; date: string; eve: string; before: ZiweiDecadalAssignment; after: ZiweiDecadalAssignment };

function springFestival(year: number): string | undefined {
  return Number.isInteger(year) ? SPRING_FESTIVAL_DATES_1900_2099[year - 1900] : undefined;
}

function assignment(palaces: ZiweiPalace[], age: number): ZiweiDecadalAssignment | null {
  const matched = palaces.filter((palace) => age >= palace.decadal.startAge && age <= palace.decadal.endAge);
  if (matched.length > 1) return null;
  const childhood = matched.length === 0;
  const names = ["命宫", "财帛", "疾厄", "夫妻", "福德", "官禄"];
  const palace = matched[0] ?? (Number.isInteger(age) && age >= 1 && age <= 6
    ? palaces.find(({ name }) => name === names[age - 1]) : undefined);
  if (palace === undefined) return null;
  return {
    kind: childhood ? "childhood" : "decadal",
    startAge: childhood ? age : palace.decadal.startAge,
    endAge: childhood ? age : palace.decadal.endAge,
    palaceIndex: palace.index,
    natalPalace: palace.name,
    earthlyBranch: palace.earthlyBranch,
    ganZhi: childhood ? `${palace.heavenlyStem}${palace.earthlyBranch}` : `${palace.decadal.heavenlyStem}${palace.decadal.earthlyBranch}`
  };
}

/** Read-only projection of the locked normal-year rules; never recalculate birth input. */
export function ziweiDecadalYearBoundary(chart: ZiweiChartV1, targetYear: number | null | undefined): ZiweiDecadalBoundary {
  if (targetYear === null || targetYear === undefined) return { status: "unselected" };
  const unavailable = { status: "unavailable" } as const;
  try {
    const config = chart.configuration;
    if (chart.schemaVersion !== "1.0.0" || chart.engine.name !== "iztro" || chart.engine.version !== "2.5.8"
      || chart.rulesetVersion !== "CyberSaga-Ziwei-v1"
      || config.algorithm !== "default" || config.yearDivide !== "normal" || config.horoscopeDivide !== "normal"
      || config.ageDivide !== "normal" || config.astroType !== "heaven" || config.fixLeap !== true
      || config.language !== "zh-CN" || config.dayDivide !== "current"
      || config.mutagens !== "iztro-2.5.8-default" || config.brightness !== "iztro-2.5.8-default") return unavailable;
    const overlay = resolveZiweiYearlyOverlay(chart, targetYear);
    const date = springFestival(targetYear);
    if (overlay === null || date === undefined || overlay.targetDate !== `${targetYear}-07-01`) return unavailable;
    const inputDate = chart.input.engineInputDate;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(inputDate) || chart.solarDate !== inputDate) return unavailable;
    const birth = LocalDate.parse(inputDate);
    const birthNewYear = springFestival(birth.year());
    if (birthNewYear === undefined) return unavailable;
    const birthLunarYear = birth.year() - (inputDate < birthNewYear ? 1 : 0);
    const ranges = [...chart.palaces].sort((a, b) => a.decadal.startAge - b.decadal.startAge);
    const palaceNames = ["命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄", "迁移", "仆役", "官禄", "田宅", "福德", "父母"];
    const stems = "甲乙丙丁戊己庚辛壬癸";
    const branches = "寅卯辰巳午未申酉戌亥子丑";
    const firstAge = ({ "水二局": 2, "木三局": 3, "金四局": 4, "土五局": 5, "火六局": 6 } as Record<string, number>)[chart.fiveElementsClass];
    if (new Set(chart.palaces.map(({ name }) => name)).size !== 12
      || !chart.palaces.every((palace, index) => palaceNames.includes(palace.name)
        && palace.earthlyBranch === branches[index] && palace.decadal.earthlyBranch === palace.earthlyBranch
        && palace.heavenlyStem.length === 1 && stems.includes(palace.heavenlyStem)
        && palace.decadal.heavenlyStem.length === 1 && stems.includes(palace.decadal.heavenlyStem))
      || ranges[0].name !== "命宫" || ranges[0].decadal.startAge !== firstAge
      || !ranges.every(({ decadal }, index) => Number.isInteger(decadal.startAge)
        && decadal.endAge === decadal.startAge + 9
        && (index === 0 || decadal.startAge === ranges[index - 1].decadal.endAge + 1))) return unavailable;
    if (inputDate >= date) return { status: "before_birth" };
    const before = assignment(chart.palaces, targetYear - birthLunarYear);
    const after = assignment(chart.palaces, targetYear - birthLunarYear + 1);
    if (before === null || after === null || overlay.decadal.index !== after.palaceIndex
      || `${overlay.decadal.heavenlyStem}${overlay.decadal.earthlyBranch}` !== after.ganZhi
      || overlay.decadal.palaceNames[after.palaceIndex] !== "命宫"
      || overlay.decadal.name !== (after.kind === "childhood" ? "童限" : "大限")) return unavailable;
    return {
      status: before.palaceIndex === after.palaceIndex && before.kind === after.kind ? "unchanged" : "changed",
      targetYear, date, eve: LocalDate.parse(date).minusDays(1).toString(), before, after
    };
  } catch {
    return unavailable;
  }
}

function assignmentText(value: ZiweiDecadalAssignment): string {
  const age = value.kind === "childhood" ? `${value.startAge} 虚岁童限` : `${value.startAge}–${value.endAge} 虚岁大限`;
  return `${value.ganZhi} · ${age}；本命${value.natalPalace}（索引 ${value.palaceIndex}，${value.earthlyBranch}）`;
}

export function ziweiDecadalBoundaryText(boundary: ZiweiDecadalBoundary): string[] {
  if (boundary.status === "unselected") return [];
  if (boundary.status === "unavailable") return [ZIWEI_DECADAL_BOUNDARY_UNAVAILABLE];
  if (boundary.status === "before_birth") return ["所选年份的春节尚未出生或恰为出生当日，不将其标记为出生后的交限。"];
  if (boundary.status === "unchanged") return [`${boundary.targetYear} 年不跨大限：${assignmentText(boundary.after)}。`, ZIWEI_DECADAL_BOUNDARY_NOTE];
  const label = boundary.before.kind === "childhood"
    ? boundary.after.kind === "childhood" ? "童限换宫日期（不属十年大限交接）" : "童限转大限日期"
    : "紫微交限日期";
  return [
    `${label}：${boundary.date}（农历正月初一；自该日起归后段）。`,
    `切换前（春节前一日 ${boundary.eve}）：${assignmentText(boundary.before)}。`,
    `切换后（春节当天 ${boundary.date}）：${assignmentText(boundary.after)}。`,
    ZIWEI_DECADAL_BOUNDARY_NOTE
  ];
}
