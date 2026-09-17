import { DateTimeFormatter, LocalDateTime } from "@js-joda/core";

import type { BaziChartV1, BaziDaYun, ZiweiChartV1, ZiweiHoroscopeItem, ZiweiYearlyFortune } from "../core/charts/types.js";

const LOCAL_SECONDS = DateTimeFormatter.ofPattern("uuuu-MM-dd HH:mm:ss");

export const BAZI_LUCK_DATE_NOTE = "年表索引不代表全年日期归属。日期区间按起运法 1 的已算起运时刻、此后每十个公历年顺延推算（含开始、不含结束）；不重新校正出生时间。";
export const DUAL_YEAR_BOUNDARY_NOTE = "八字以立春换年、十二节分月；紫微以农历正月初一换年。紫微年度叠加取目标年 7 月 1 日的代表盘，不表示全年任意日期均处同一运限。";
export const BAZI_LUCK_DATE_UNAVAILABLE = "大运日期分段不可用：现有文档的出生或起运时刻不完整、起运早于出生，或大运年表不一致；请重新计算后查看。";

export interface BaziDaYunDateInterval {
  daYunIndex: number;
  ganZhi: string | null;
  start: string;
  end: string;
}

export function baziDaYunAnnualLabels(period: BaziDaYun): { age: string; years: string } {
  if (period.index === 0 && period.endYear === period.startYear - 1) {
    return { age: "出生当年起运", years: "年表第 0 段为空" };
  }
  return { age: `年表虚岁 ${period.startAge}–${period.endAge}`, years: `年表 ${period.startYear}–${period.endYear}` };
}

/** A display projection of the stored luckSect=1 start, not another birth-time calculation. */
export function baziDaYunDateIntervals(chart: BaziChartV1): BaziDaYunDateInterval[] | null {
  let firstStart: LocalDateTime;
  let birth: LocalDateTime;
  try {
    const times = [chart.luck.startSolarDateTime, chart.calendar.solarDateTime];
    if (!times.every((time) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(time))) return null;
    firstStart = LocalDateTime.parse(times[0].replace(" ", "T"));
    birth = LocalDateTime.parse(times[1].replace(" ", "T"));
  } catch {
    return null;
  }
  if (firstStart.isBefore(birth) || chart.configuration.luckSect !== 1) return null;
  if (!chart.luck.daYun.every((period, index) => (
    period.index === index && (index === 0
      ? period.startYear === birth.year() && period.endYear === firstStart.year() - 1
      : period.startYear === firstStart.year() + (index - 1) * 10 && period.endYear === period.startYear + 9)
  ))) return null;
  return chart.luck.daYun.map((period) => ({
    daYunIndex: period.index,
    ganZhi: period.ganZhi,
    start: (period.index === 0 ? birth : firstStart.plusYears((period.index - 1) * 10)).format(LOCAL_SECONDS),
    end: (period.index === 0 ? firstStart : firstStart.plusYears(period.index * 10)).format(LOCAL_SECONDS)
  }));
}

export function baziDaYunYearIntervals(chart: BaziChartV1, year: number): BaziDaYunDateInterval[] | null {
  const start = `${year}-01-01 00:00:00`;
  const end = `${year + 1}-01-01 00:00:00`;
  const intervals = baziDaYunDateIntervals(chart);
  if (intervals === null) return null;
  return intervals
    .map((period) => ({ ...period, start: period.start < start ? start : period.start, end: period.end > end ? end : period.end }))
    .filter((period) => period.start < period.end);
}

export function baziDaYunIntervalText(period: BaziDaYunDateInterval): string {
  return `${period.start} 至 ${period.end}（不含结束）：${period.ganZhi ?? "起运前"}（第 ${period.daYunIndex} 段）`;
}

function hasTwelveAlignedOverlaySlots(item: ZiweiHoroscopeItem): boolean {
  return item !== null && typeof item === "object"
    && Array.isArray(item.palaceNames) && item.palaceNames.length === 12
    && Array.isArray(item.starsByPalace) && item.starsByPalace.length === 12
    && Array.isArray(item.transformations) && item.transformations.length === 4
    && item.transformations.every((name) => typeof name === "string" && name.trim() !== "")
    && Number.isInteger(item.index) && item.index >= 0 && item.index < 12
    && item.palaceNames[item.index] === "命宫" && new Set(item.palaceNames).size === 12
    && Array.from({ length: 12 }, (_, index) => index).every((index) => (
      typeof item.palaceNames[index] === "string" && item.palaceNames[index].trim() !== "" && Array.isArray(item.starsByPalace[index])
    ));
}

/** Shared by the page and text so every overlay is indexed against the same natal palace. */
export function resolveZiweiYearlyOverlay(chart: ZiweiChartV1, selectedYear: number | null | undefined): ZiweiYearlyFortune | null {
  if (selectedYear === null || selectedYear === undefined) return null;
  const matches = chart.yearlyFortunes?.filter(({ targetYear }) => targetYear === selectedYear) ?? [];
  if (matches.length !== 1 || !Array.isArray(chart.palaces) || chart.palaces.length !== 12 || !chart.palaces.every((palace, index) => palace.index === index)) return null;
  const fortune = matches[0];
  return hasTwelveAlignedOverlaySlots(fortune.decadal) && hasTwelveAlignedOverlaySlots(fortune.yearly) ? fortune : null;
}

export function ziweiPalaceRelations(chart: ZiweiChartV1, overlay: ZiweiYearlyFortune | null) {
  return chart.palaces.map((palace) => ({
    index: palace.index,
    earthlyBranch: palace.earthlyBranch,
    natal: palace.name,
    decadal: overlay?.decadal.palaceNames[palace.index] ?? null,
    yearly: overlay?.yearly.palaceNames[palace.index] ?? null,
    oppositeIndex: (palace.index + 6) % 12,
    trineIndexes: [(palace.index + 4) % 12, (palace.index + 8) % 12]
  }));
}

export function ziweiHoroscopeTransformations(chart: ZiweiChartV1, item: ZiweiHoroscopeItem) {
  const completeStarLists = chart.palaces.length === 12 && chart.palaces.every((palace) => Array.isArray(palace.majorStars) && Array.isArray(palace.minorStars));
  return (["禄", "权", "科", "忌"] as const).map((transformation, index) => {
    const starName = item.transformations?.[index];
    const locations = completeStarLists ? chart.palaces.flatMap((palace) => (
      [...palace.majorStars, ...palace.minorStars].filter((star) => star.name === starName).map(() => palace)
    )) : [];
    return {
      transformation,
      starName,
      natalPalace: locations.length === 1 ? locations[0] : null
    };
  });
}

export function ziweiTransformationText(item: ReturnType<typeof ziweiHoroscopeTransformations>[number]): string {
  const palace = item.natalPalace;
  return `${item.transformation}：${item.starName ?? "未提供"}；本命落宫：${palace === null
    ? "未能在本文件所列主辅星中唯一定位"
    : `${palace.name}（索引 ${palace.index}，${palace.earthlyBranch}）`}`;
}
