import { Lunar, LunarYear } from "lunar-typescript";

import type { BirthRecordAny } from "../../shared/contracts.js";

export type CalendarBasis = "solar" | "lunar_regular" | "lunar_leap";

export interface CalendarResolution {
  id: string;
  basis: CalendarBasis;
  status: "valid" | "invalid";
  sourceDate: string;
  solarDate: string | null;
  note: string;
}

export type ValidCalendarResolution = CalendarResolution & {
  status: "valid";
  solarDate: string;
};

type CalendarRecord = Pick<BirthRecordAny, "caseId" | "calendar">;

function lunarCalendarResolution(
  record: CalendarRecord,
  basis: "lunar_regular" | "lunar_leap"
): CalendarResolution {
  const [year, month, day] = record.calendar.date.split("-").map(Number);
  const leap = basis === "lunar_leap";
  const lunarMonth = leap ? -month : month;
  const id = `${record.caseId}:calendar:${leap ? "1-lunar_leap" : "0-lunar_regular"}`;
  const monthInfo = LunarYear.fromYear(year).getMonth(lunarMonth);
  if (monthInfo === null) {
    return {
      id,
      basis,
      status: "invalid",
      sourceDate: record.calendar.date,
      solarDate: null,
      note: leap
        ? `非法闰月：${year} 年没有闰 ${month} 月`
        : `非法农历月份：${record.calendar.date}`
    };
  }
  if (day > monthInfo.getDayCount()) {
    return {
      id,
      basis,
      status: "invalid",
      sourceDate: record.calendar.date,
      solarDate: null,
      note: `非法农历日期：${record.calendar.date}`
    };
  }

  const lunar = Lunar.fromYmd(year, lunarMonth, day);
  if (lunar.getYear() !== year || lunar.getMonth() !== lunarMonth || lunar.getDay() !== day) {
    return {
      id,
      basis,
      status: "invalid",
      sourceDate: record.calendar.date,
      solarDate: null,
      note: `非法农历日期：${record.calendar.date}`
    };
  }
  return {
    id,
    basis,
    status: "valid",
    sourceDate: record.calendar.date,
    solarDate: lunar.getSolar().toYmd(),
    note: leap ? "按闰月口径转换" : "按普通月口径转换"
  };
}

export function resolveCalendarResolutions(record: CalendarRecord): CalendarResolution[] {
  if (record.calendar.type === "solar") {
    return [{
      id: `${record.caseId}:calendar:solar`,
      basis: "solar",
      status: "valid",
      sourceDate: record.calendar.date,
      solarDate: record.calendar.date,
      note: "原始记录为公历"
    }];
  }
  const resolutions = record.calendar.leapMonth === "unknown"
    ? [
        lunarCalendarResolution(record, "lunar_regular"),
        lunarCalendarResolution(record, "lunar_leap")
      ]
    : [lunarCalendarResolution(record, record.calendar.leapMonth ? "lunar_leap" : "lunar_regular")];
  if (record.calendar.leapMonth !== "unknown" && resolutions[0].status === "invalid") {
    throw new Error(resolutions[0].note);
  }
  if (!resolutions.some((resolution) => resolution.status === "valid")) {
    throw new Error("农历普通月与闰月口径均无有效日期");
  }
  return resolutions;
}
