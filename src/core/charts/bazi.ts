import { I18n, Solar, type EightChar } from "lunar-typescript";

import { resolveEngineLocalDateTime, resolveTargetYears, toMinuteLocalDateTime } from "./input.js";
import type {
  BaziAnnualFortune,
  BaziChartV1,
  BaziPillar,
  ChartBirthRecord,
  ChartCalculationOptions,
  ChartTimeCandidate
} from "./types.js";

export const BAZI_ENGINE = {
  name: "lunar-typescript",
  version: "1.8.6"
} as const;

type PillarName = "Year" | "Month" | "Day" | "Time";

export function withLockedLunarLanguage<T>(
  callback: () => T,
  ..._syncOnly: Extract<T, PromiseLike<unknown>> extends never ? [] : [never]
): T {
  const previous = I18n.getLanguage();
  I18n.setLanguage("chs");
  try {
    const value = callback();
    if (
      value !== null
      && (typeof value === "object" || typeof value === "function")
      && "then" in value
      && typeof value.then === "function"
    ) {
      throw new Error("LUNAR_LANGUAGE_CALLBACK_MUST_BE_SYNC");
    }
    return value;
  } finally {
    I18n.setLanguage(previous);
  }
}

function normalizePillar(eightChar: EightChar, name: PillarName): BaziPillar {
  const call = <T>(suffix: string): T => {
    const methodName = `get${name}${suffix}` as keyof EightChar;
    const method = eightChar[methodName] as unknown as () => T;
    return method.call(eightChar);
  };
  return {
    ganZhi: call<string>(""),
    heavenlyStem: call<string>("Gan"),
    earthlyBranch: call<string>("Zhi"),
    hiddenStems: [...call<string[]>("HideGan")],
    stemTenGod: call<string>("ShiShenGan"),
    hiddenStemTenGods: [...call<string[]>("ShiShenZhi")],
    naYin: call<string>("NaYin"),
    xun: call<string>("Xun"),
    voidBranches: call<string>("XunKong"),
    growthStage: call<string>("DiShi")
  };
}

export function calculateBaziChart(
  record: ChartBirthRecord,
  candidate: ChartTimeCandidate,
  options: ChartCalculationOptions = {}
): BaziChartV1 {
  return withLockedLunarLanguage(() => calculateBaziChartWithLockedLanguage(record, candidate, options));
}

function calculateBaziChartWithLockedLanguage(
  record: ChartBirthRecord,
  candidate: ChartTimeCandidate,
  options: ChartCalculationOptions
): BaziChartV1 {
  const calculationDateTime = candidate.localDateTime;
  const engineDateTime = resolveEngineLocalDateTime(candidate);
  const solar = Solar.fromYmdHms(
    engineDateTime.year(),
    engineDateTime.monthValue(),
    engineDateTime.dayOfMonth(),
    engineDateTime.hour(),
    engineDateTime.minute(),
    0
  );
  const lunar = solar.getLunar();
  const eightChar = lunar.getEightChar();
  const pillarSect: 1 | 2 = candidate.ziSegment === "late" && candidate.dayBoundary === "forward" ? 1 : 2;
  eightChar.setSect(pillarSect);
  const genderCode: 0 | 1 = record.gender === "男" ? 1 : 0;
  const luckSect = 1 as const;
  const yun = eightChar.getYun(genderCode, luckSect);
  const daYunCount = options.daYunCount ?? 12;
  if (!Number.isInteger(daYunCount) || daYunCount < 1 || daYunCount > 20) {
    throw new Error("daYunCount 必须是 1–20 的整数");
  }
  const targetYears = resolveTargetYears(Number(calculationDateTime.slice(0, 4)), options);
  const birthYear = solar.getYear();
  const beforeBirth = targetYears.find((targetYear) => targetYear < birthYear);
  if (beforeBirth !== undefined) {
    throw new Error(`TARGET_YEAR_BEFORE_BIRTH:${beforeBirth}`);
  }
  const targetYearSet = new Set(targetYears);
  const annualFortunes: BaziAnnualFortune[] = [];
  const daYun = yun.getDaYun(daYunCount).map((period) => {
    const periodLength = period.getEndYear() - period.getStartYear() + 1;
    for (const year of period.getLiuNian(periodLength)) {
      if (targetYearSet.has(year.getYear())) {
        annualFortunes.push({
          year: year.getYear(),
          age: year.getAge(),
          ganZhi: year.getGanZhi(),
          xun: year.getXun(),
          voidBranches: year.getXunKong(),
          daYunIndex: period.getIndex()
        });
      }
    }
    const ganZhi = period.getGanZhi();
    return {
      index: period.getIndex(),
      startAge: period.getStartAge(),
      endAge: period.getEndAge(),
      startYear: period.getStartYear(),
      endYear: period.getEndYear(),
      ganZhi: ganZhi || null,
      xun: ganZhi ? period.getXun() : null,
      voidBranches: ganZhi ? period.getXunKong() : null
    };
  });
  annualFortunes.sort((left, right) => left.year - right.year || left.daYunIndex - right.daYunIndex);
  for (const targetYear of targetYears) {
    const matches = annualFortunes.filter((fortune) => fortune.year === targetYear);
    if (matches.length === 0) {
      throw new Error(`BAZI_TARGET_YEAR_UNAVAILABLE:${targetYear}`);
    }
    if (matches.length > 1) {
      throw new Error(`BAZI_TARGET_YEAR_DUPLICATE:${targetYear}`);
    }
  }

  const year = normalizePillar(eightChar, "Year");
  const month = normalizePillar(eightChar, "Month");
  const day = normalizePillar(eightChar, "Day");
  const time = normalizePillar(eightChar, "Time");

  return {
    schemaVersion: "1.0.0",
    rulesetVersion: "CyberSaga-Bazi-v1",
    candidateId: candidate.id,
    engine: BAZI_ENGINE,
    configuration: {
      pillarSect,
      luckSect,
      yearBoundary: "li_chun",
      monthBoundary: "solar_terms",
      sourceDayBoundary: candidate.dayBoundary
    },
    input: {
      sourceLocalDateTime: toMinuteLocalDateTime(engineDateTime),
      calculationLocalDateTime: calculationDateTime,
      timeBasis: candidate.basis,
      earthlyBranchIndex: candidate.earthlyBranch.index
    },
    calendar: {
      solarDate: solar.toYmd(),
      solarDateTime: solar.toYmdHms(),
      lunarYear: lunar.getYear(),
      lunarMonth: Math.abs(lunar.getMonth()),
      lunarDay: lunar.getDay(),
      isLeapMonth: lunar.getMonth() < 0,
      lunarText: lunar.toString()
    },
    fourPillars: [year.ganZhi, month.ganZhi, day.ganZhi, time.ganZhi],
    pillars: { year, month, day, time },
    luck: {
      genderCode,
      forward: yun.isForward(),
      startSolarDateTime: yun.getStartSolar().toYmdHms(),
      startAfter: {
        years: yun.getStartYear(),
        months: yun.getStartMonth(),
        days: yun.getStartDay(),
        hours: yun.getStartHour()
      },
      daYun
    },
    annualFortunes
  };
}
