import { LocalDate, LocalDateTime } from "@js-joda/core";
import { Solar } from "lunar-typescript";
import { createRequire } from "node:module";
import { astro, data } from "iztro";

import { resolveEngineLocalDateTime, resolveTargetYears, toMinuteLocalDateTime } from "./input.js";
import type {
  ChartBirthRecord,
  ChartCalculationOptions,
  ChartTimeCandidate,
  NormalizedZiweiStar,
  ZiweiChartV1,
  ZiweiHoroscopeItem
} from "./types.js";

export const ZIWEI_ENGINE = {
  name: "iztro",
  version: "2.5.8"
} as const;

const BASE_CONFIG = {
  algorithm: "default",
  yearDivide: "normal",
  horoscopeDivide: "normal",
  ageDivide: "normal",
  mutagens: "iztro-2.5.8-default",
  brightness: "iztro-2.5.8-default",
  astroType: "heaven",
  fixLeap: true,
  language: "zh-CN"
} as const;

type IztroConfig = Parameters<typeof astro.config>[0];
type IztroRuntimeConfig = ReturnType<typeof astro.getConfig>;

interface IztroI18nRuntime {
  language?: string;
  changeLanguage(language: string): Promise<unknown>;
}

const requireFromIztro = createRequire(import.meta.resolve("iztro"));
const iztroI18n = requireFromIztro("i18next") as IztroI18nRuntime;

const LOCKED_MUTAGENS = Object.fromEntries(data.HEAVENLY_STEMS.map((stem) => [
  stem,
  [...data.heavenlyStems[stem].mutagen]
])) as NonNullable<IztroConfig["mutagens"]>;

const LOCKED_BRIGHTNESS = Object.fromEntries(Object.entries(data.STARS_INFO).map(([star, info]) => [
  star,
  [...info.brightness]
])) as NonNullable<IztroConfig["brightness"]>;

const APPROVED_HOROSCOPE_STAR_TYPES = new Set(["soft", "lucun", "tough", "tianma"]);

function normalizeStar(star: {
  name: string;
  type: string;
  scope: string;
  brightness?: string;
  mutagen?: string;
}): NormalizedZiweiStar {
  return {
    name: star.name,
    type: star.type,
    scope: star.scope,
    brightness: star.brightness || null,
    transformation: star.mutagen || null
  };
}

function normalizeHoroscopeItem(item: {
  index: number;
  name: string;
  heavenlyStem: string;
  earthlyBranch: string;
  palaceNames: readonly string[];
  mutagen: readonly string[];
  stars?: readonly (readonly {
    name: string;
    type: string;
    scope: string;
    brightness?: string;
    mutagen?: string;
  }[])[];
}): ZiweiHoroscopeItem {
  return {
    index: item.index,
    name: item.name,
    heavenlyStem: item.heavenlyStem,
    earthlyBranch: item.earthlyBranch,
    palaceNames: [...item.palaceNames],
    transformations: [...item.mutagen],
    starsByPalace: (item.stars ?? []).map((stars) => stars
      .filter((star) => APPROVED_HOROSCOPE_STAR_TYPES.has(star.type))
      .map(normalizeStar))
  };
}

function snapshotIztroConfig(): IztroRuntimeConfig {
  return structuredClone(astro.getConfig());
}

function snapshotIztroLanguage(): string {
  if (!iztroI18n.language) {
    throw new Error("IZTRO_LANGUAGE_UNAVAILABLE: cannot snapshot iztro i18n language");
  }
  return iztroI18n.language;
}

function restoreIztroConfig(snapshot: IztroRuntimeConfig): void {
  const current = astro.getConfig();

  for (const tableName of ["mutagens", "brightness"] as const) {
    const currentTable = current[tableName] as Record<string, unknown>;
    for (const key of Object.keys(currentTable)) {
      delete currentTable[key];
    }
    Object.assign(currentTable, structuredClone(snapshot[tableName]));
  }

  astro.config(snapshot as IztroConfig);
}

function restoreIztroLanguage(language: string): void {
  void iztroI18n.changeLanguage(language);
}

export function calculateZiweiChart(
  record: ChartBirthRecord,
  candidate: ChartTimeCandidate,
  options: ChartCalculationOptions = {}
): ZiweiChartV1 {
  return withLockedIztroRuntime(() => calculateZiweiChartWithLockedConfig(record, candidate, options));
}

function withLockedIztroRuntime<T>(callback: () => T): T {
  const previousConfig = snapshotIztroConfig();
  const previousLanguage = snapshotIztroLanguage();
  try {
    return callback();
  } finally {
    try {
      restoreIztroConfig(previousConfig);
    } finally {
      restoreIztroLanguage(previousLanguage);
    }
  }
}

export function filterZiweiSupportedTargetYears(
  record: ChartBirthRecord,
  candidate: ChartTimeCandidate,
  targetYears: readonly number[],
  natalSnapshot?: Pick<ZiweiChartV1, "candidateId" | "input" | "palaces">
): number[] {
  if (natalSnapshot === undefined) {
    return withLockedIztroRuntime(() => {
      const { chart } = createLockedAstrolabe(record, candidate);
      return targetYears.filter((targetYear) => (
        chart.horoscope(`${targetYear}-07-01`, candidate.earthlyBranch.index).decadal.index >= 0
      ));
    });
  }
  if (natalSnapshot.candidateId !== candidate.id) {
    throw new Error(`ZIWEI_NATAL_SNAPSHOT_CANDIDATE_MISMATCH:${candidate.id}`);
  }
  const birthDate = LocalDate.parse(natalSnapshot.input.engineInputDate);
  const birthLunarYear = Solar.fromYmd(
    birthDate.year(),
    birthDate.monthValue(),
    birthDate.dayOfMonth()
  ).getLunar().getYear();
  const decadalRanges = natalSnapshot.palaces.map((palace) => [
    palace.decadal.startAge,
    palace.decadal.endAge
  ] as const);
  return targetYears.filter((targetYear) => {
    const targetDate = LocalDate.parse(`${targetYear}-07-01`);
    const targetLunarYear = Solar.fromYmd(
      targetDate.year(),
      targetDate.monthValue(),
      targetDate.dayOfMonth()
    ).getLunar().getYear();
    const nominalAge = targetLunarYear - birthLunarYear + 1;
    return nominalAge >= 1 && (
      nominalAge <= 6
      || decadalRanges.some(([startAge, endAge]) => nominalAge >= startAge && nominalAge <= endAge)
    );
  });
}

function createLockedAstrolabe(record: ChartBirthRecord, candidate: ChartTimeCandidate) {
  const calculation = LocalDateTime.parse(candidate.localDateTime);
  const sourceDateTime = resolveEngineLocalDateTime(candidate);
  const forwardLateZi = candidate.ziSegment === "late" && candidate.dayBoundary === "forward";
  const engineInputDate = (forwardLateZi ? calculation : sourceDateTime).toLocalDate().toString();
  const sourceTimeIndex = candidate.ziSegment === "late" ? 12 : candidate.earthlyBranch.index;
  const timeIndex = forwardLateZi ? 0 : sourceTimeIndex;
  const dayDivide = "current" as const;
  const chart = astro.withOptions({
    type: "solar",
    dateStr: engineInputDate,
    timeIndex,
    gender: record.gender,
    fixLeap: BASE_CONFIG.fixLeap,
    language: BASE_CONFIG.language,
    astroType: BASE_CONFIG.astroType,
    config: {
      mutagens: LOCKED_MUTAGENS,
      brightness: LOCKED_BRIGHTNESS,
      algorithm: BASE_CONFIG.algorithm,
      yearDivide: BASE_CONFIG.yearDivide,
      horoscopeDivide: BASE_CONFIG.horoscopeDivide,
      ageDivide: BASE_CONFIG.ageDivide,
      dayDivide
    }
  });
  return { calculation, sourceDateTime, engineInputDate, sourceTimeIndex, timeIndex, dayDivide, chart };
}

function calculateZiweiChartWithLockedConfig(
  _record: ChartBirthRecord,
  candidate: ChartTimeCandidate,
  options: ChartCalculationOptions = {}
): ZiweiChartV1 {
  const calculationDateTime = candidate.localDateTime;
  const { sourceDateTime, engineInputDate, sourceTimeIndex, timeIndex, dayDivide, chart } = createLockedAstrolabe(_record, candidate);
  const targetYears = resolveTargetYears(Number(calculationDateTime.slice(0, 4)), options);
  const birthYear = sourceDateTime.year();
  const beforeBirth = targetYears.find((targetYear) => targetYear < birthYear);
  if (beforeBirth !== undefined) {
    throw new Error(`TARGET_YEAR_BEFORE_BIRTH:${beforeBirth}`);
  }
  const palaces = chart.palaces
    .map((palace) => ({
      index: palace.index,
      name: palace.name,
      isBodyPalace: palace.isBodyPalace,
      isOriginalPalace: palace.isOriginalPalace,
      heavenlyStem: palace.heavenlyStem,
      earthlyBranch: palace.earthlyBranch,
      majorStars: palace.majorStars.map(normalizeStar),
      minorStars: palace.minorStars.map(normalizeStar),
      changsheng12: palace.changsheng12,
      decadal: {
        startAge: palace.decadal.range[0],
        endAge: palace.decadal.range[1],
        heavenlyStem: palace.decadal.heavenlyStem,
        earthlyBranch: palace.decadal.earthlyBranch
      },
      ages: [...palace.ages]
    }))
    .sort((left, right) => left.index - right.index);

  const transformationOrder = new Map([
    ["禄", 0],
    ["权", 1],
    ["科", 2],
    ["忌", 3]
  ]);
  const transformations = palaces
    .flatMap((palace) => [
      ...palace.majorStars,
      ...palace.minorStars
    ].filter((star) => star.transformation !== null).map((star) => ({
      palaceIndex: palace.index,
      palaceName: palace.name,
      starName: star.name,
      transformation: star.transformation as string
    })))
    .sort((left, right) => (
      (transformationOrder.get(left.transformation) ?? 99)
      - (transformationOrder.get(right.transformation) ?? 99)
      || left.palaceIndex - right.palaceIndex
      || (left.starName < right.starName ? -1 : left.starName > right.starName ? 1 : 0)
    ));

  const yearlyFortunes = targetYears.map((targetYear) => {
    const targetDate = `${targetYear}-07-01`;
    const horoscope = chart.horoscope(targetDate, candidate.earthlyBranch.index);
    if (horoscope.decadal.index < 0) {
      throw new Error(`ZIWEI_TARGET_YEAR_UNAVAILABLE:${targetYear}`);
    }
    return {
      targetYear,
      targetDate,
      solarDate: horoscope.solarDate,
      lunarDate: horoscope.lunarDate,
      decadal: normalizeHoroscopeItem(horoscope.decadal),
      yearly: normalizeHoroscopeItem(horoscope.yearly)
    };
  });

  return {
    schemaVersion: "1.0.0",
    rulesetVersion: "CyberSaga-Ziwei-v1",
    candidateId: candidate.id,
    engine: ZIWEI_ENGINE,
    configuration: {
      ...BASE_CONFIG,
      dayDivide,
      sourceTimeIndex,
      timeIndex
    },
    input: {
      sourceLocalDateTime: toMinuteLocalDateTime(sourceDateTime),
      calculationLocalDateTime: calculationDateTime,
      timeBasis: candidate.basis,
      sourceZiSegment: candidate.ziSegment,
      sourceDayBoundary: candidate.dayBoundary,
      engineInputDate
    },
    gender: _record.gender,
    solarDate: chart.solarDate,
    lunarDate: chart.lunarDate,
    chineseDate: chart.chineseDate,
    time: chart.time,
    timeRange: chart.timeRange,
    soulPalaceBranch: chart.earthlyBranchOfSoulPalace,
    bodyPalaceBranch: chart.earthlyBranchOfBodyPalace,
    soul: chart.soul,
    body: chart.body,
    fiveElementsClass: chart.fiveElementsClass,
    palaces,
    transformations,
    yearlyFortunes
  };
}
