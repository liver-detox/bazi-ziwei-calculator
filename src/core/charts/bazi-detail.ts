import { LunarUtil, Solar, type DaYun, type EightChar } from "lunar-typescript";

import { BAZI_ENGINE, withLockedLunarLanguage } from "./bazi.js";
import {
  computeBaziDetailFingerprint,
  computeBaziDetailSourceIdentityFromStrict,
  computeSourceBaziCandidateFingerprintFromStrict,
  parseBoundBaziDetail,
  parseStrictBaziDetailSources,
  type BaziDetailSourcesV1
} from "./bazi-detail-fingerprints.js";
import type {
  BaziDetailCandidateV1,
  BaziDetailV1,
  BaziGanZhiRelationsV1,
  EngineSolarTermBoundaryV1
} from "./bazi-detail-contract.js";
import { resolveEngineLocalDateTime } from "./input.js";
import { filterZiweiSupportedTargetYears } from "./ziwei.js";

export type BaziDetailFailureCode =
  | "BAZI_DETAIL_AUXILIARY_PILLAR_UNAVAILABLE"
  | "BAZI_DETAIL_DAYUN_RELATION_UNAVAILABLE"
  | "BAZI_DETAIL_XIAOYUN_NOT_UNIQUE"
  | "BAZI_DETAIL_LIUYUE_NOT_UNIQUE"
  | "BAZI_DETAIL_JIEQI_NOT_UNIQUE";

export class BaziDetailGenerationError extends Error {
  readonly code: BaziDetailFailureCode;

  constructor(code: BaziDetailFailureCode, message: string = code) {
    super(message);
    this.name = "BaziDetailGenerationError";
    this.code = code;
  }
}

export class TargetYearOutsideSharedSupportedSetError extends Error {
  readonly code = "TARGET_YEAR_OUTSIDE_SHARED_SUPPORTED_SET" as const;
  readonly year: number;

  constructor(year: number) {
    super(`TARGET_YEAR_OUTSIDE_SHARED_SUPPORTED_SET:${year}`);
    this.name = "TargetYearOutsideSharedSupportedSetError";
    this.year = year;
  }
}

const BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"] as const;
const JIE_QI_NAMES = ["立春", "惊蛰", "清明", "立夏", "芒种", "小暑", "立秋", "白露", "寒露", "立冬", "大雪", "小寒", "立春"] as const;
const SOLAR_MONTH_NAMES = ["寅月", "卯月", "辰月", "巳月", "午月", "未月", "申月", "酉月", "戌月", "亥月", "子月", "丑月"] as const;

function fail(code: BaziDetailFailureCode, message?: string): never {
  throw new BaziDetailGenerationError(code, message);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function rebuildCandidate(
  sources: BaziDetailSourcesV1,
  candidateId: string
): { eightChar: EightChar; daYun: DaYun[] } {
  const base = sources.baseChartSet.candidates.find((candidate) => candidate.candidateId === candidateId)!;
  const candidate = sources.timeEvidence.candidates.find((item) => item.id === candidateId)!;
  const dateTime = resolveEngineLocalDateTime(candidate);
  const solar = Solar.fromYmdHms(
    dateTime.year(), dateTime.monthValue(), dateTime.dayOfMonth(),
    dateTime.hour(), dateTime.minute(), 0
  );
  const eightChar = solar.getLunar().getEightChar();
  eightChar.setSect(base.bazi.configuration.pillarSect);
  const yun = eightChar.getYun(base.bazi.luck.genderCode, base.bazi.configuration.luckSect);
  const daYun = yun.getDaYun(base.bazi.luck.daYun.length);
  if (daYun.length !== base.bazi.luck.daYun.length) {
    fail("BAZI_DETAIL_DAYUN_RELATION_UNAVAILABLE", `${candidateId}: DaYun count mismatch`);
  }
  daYun.forEach((period, index) => {
    const saved = base.bazi.luck.daYun[index];
    const ganZhi = period.getGanZhi();
    if (
      period.getIndex() !== saved.index
      || period.getStartAge() !== saved.startAge
      || period.getEndAge() !== saved.endAge
      || period.getStartYear() !== saved.startYear
      || period.getEndYear() !== saved.endYear
      || (ganZhi || null) !== saved.ganZhi
      || (ganZhi ? period.getXun() : null) !== saved.xun
      || (ganZhi ? period.getXunKong() : null) !== saved.voidBranches
    ) {
      fail("BAZI_DETAIL_DAYUN_RELATION_UNAVAILABLE", `${candidateId}: DaYun identity mismatch at ${index}`);
    }
  });
  return { eightChar, daYun };
}

function relations(
  eightChar: EightChar,
  ganZhi: string,
  code: BaziDetailFailureCode
): BaziGanZhiRelationsV1 {
  if (!nonEmpty(ganZhi) || Array.from(ganZhi).length !== 2) fail(code, `invalid GanZhi: ${ganZhi}`);
  const [stem, branch] = Array.from(ganZhi);
  const hiddenStems = LunarUtil.ZHI_HIDE_GAN[branch];
  if (!Array.isArray(hiddenStems) || hiddenStems.length === 0) fail(code, `hidden stems unavailable: ${branch}`);
  const stemTenGod = LunarUtil.SHI_SHEN[eightChar.getDayGan() + stem];
  const hiddenStemTenGods = hiddenStems.map((hidden) => LunarUtil.SHI_SHEN[eightChar.getDayGan() + hidden]);
  const branchIndex = BRANCHES.indexOf(branch as typeof BRANCHES[number]);
  const growthStage = branchIndex < 0 ? "" : eightChar.getDiShi(branchIndex);
  const naYin = LunarUtil.NAYIN[ganZhi];
  if (
    !nonEmpty(stemTenGod)
    || hiddenStemTenGods.some((item) => !nonEmpty(item))
    || !nonEmpty(growthStage)
    || !nonEmpty(naYin)
  ) fail(code, `relations unavailable: ${ganZhi}`);
  return {
    stemTenGod,
    branchMainQiTenGod: hiddenStemTenGods[0],
    hiddenStems: [...hiddenStems],
    hiddenStemTenGods,
    growthStage,
    naYin
  };
}

function auxiliaryPillar(
  ganZhi: string,
  naYin: string
): { ganZhi: string; naYin: string } {
  if (!nonEmpty(ganZhi) || !nonEmpty(naYin) || LunarUtil.NAYIN[ganZhi] !== naYin) {
    fail("BAZI_DETAIL_AUXILIARY_PILLAR_UNAVAILABLE");
  }
  return { ganZhi, naYin };
}

function jieQiBoundaries(year: number): EngineSolarTermBoundaryV1[] {
  const current = Solar.fromYmd(year, 7, 1).getLunar().getJieQiTable();
  const next = Solar.fromYmd(year + 1, 7, 1).getLunar().getJieQiTable();
  const boundaries = JIE_QI_NAMES.map((name, index) => {
    const solar = index < 11 ? current[name] : next[name];
    const engineDateTime = solar?.toYmdHms();
    if (!nonEmpty(engineDateTime) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(engineDateTime)) {
      fail("BAZI_DETAIL_JIEQI_NOT_UNIQUE", `${year}:${name}`);
    }
    return { name, engineDateTime };
  });
  if (
    !boundaries[0].engineDateTime.startsWith(`${year}-`)
    || !boundaries[11].engineDateTime.startsWith(`${year + 1}-`)
    || !boundaries[12].engineDateTime.startsWith(`${year + 1}-`)
    || boundaries.some((boundary, index) => index > 0 && boundary.engineDateTime <= boundaries[index - 1].engineDateTime)
  ) fail("BAZI_DETAIL_JIEQI_NOT_UNIQUE", `${year}: invalid JieQi sequence`);
  return boundaries;
}

function buildCandidateDetail(
  sources: BaziDetailSourcesV1,
  candidateId: string
): BaziDetailCandidateV1 {
  const base = sources.baseChartSet.candidates.find((candidate) => candidate.candidateId === candidateId)!;
  const { eightChar, daYun } = rebuildCandidate(sources, candidateId);
  const annualDetails = base.bazi.annualFortunes.map((savedAnnual) => {
    const period = daYun[savedAnnual.daYunIndex];
    if (!period) fail("BAZI_DETAIL_LIUYUE_NOT_UNIQUE", `${candidateId}:${savedAnnual.year}: DaYun unavailable`);
    const periodLength = period.getEndYear() - period.getStartYear() + 1;
    const liuNianMatches = period.getLiuNian(periodLength).filter((item) => item.getYear() === savedAnnual.year);
    if (liuNianMatches.length !== 1) fail("BAZI_DETAIL_LIUYUE_NOT_UNIQUE", `${candidateId}:${savedAnnual.year}: LiuNian not unique`);
    const liuNian = liuNianMatches[0];
    if (
      liuNian.getAge() !== savedAnnual.age
      || liuNian.getGanZhi() !== savedAnnual.ganZhi
      || liuNian.getXun() !== savedAnnual.xun
      || liuNian.getXunKong() !== savedAnnual.voidBranches
    ) fail("BAZI_DETAIL_LIUYUE_NOT_UNIQUE", `${candidateId}:${savedAnnual.year}: LiuNian identity mismatch`);
    const xiaoYunMatches = period.getXiaoYun(periodLength).filter((item) => item.getYear() === savedAnnual.year);
    if (xiaoYunMatches.length !== 1) fail("BAZI_DETAIL_XIAOYUN_NOT_UNIQUE", `${candidateId}:${savedAnnual.year}`);
    const xiaoYun = xiaoYunMatches[0];
    const liuYue = liuNian.getLiuYue();
    if (liuYue.length !== 12) fail("BAZI_DETAIL_LIUYUE_NOT_UNIQUE", `${candidateId}:${savedAnnual.year}`);
    const boundaries = jieQiBoundaries(savedAnnual.year);
    return {
      year: savedAnnual.year,
      daYunIndex: savedAnnual.daYunIndex,
      relations: relations(eightChar, savedAnnual.ganZhi, "BAZI_DETAIL_DAYUN_RELATION_UNAVAILABLE"),
      xiaoYun: {
        year: xiaoYun.getYear(),
        virtualAge: xiaoYun.getAge(),
        ganZhi: xiaoYun.getGanZhi(),
        xun: xiaoYun.getXun(),
        voidBranches: xiaoYun.getXunKong(),
        relations: relations(eightChar, xiaoYun.getGanZhi(), "BAZI_DETAIL_XIAOYUN_NOT_UNIQUE")
      },
      liuYue: liuYue.map((month, index) => ({
        ordinal: index + 1,
        monthName: SOLAR_MONTH_NAMES[index],
        interval: {
          start: boundaries[index],
          end: boundaries[index + 1],
          semantics: "half_open" as const
        },
        ganZhi: month.getGanZhi(),
        xun: month.getXun(),
        voidBranches: month.getXunKong(),
        relations: relations(eightChar, month.getGanZhi(), "BAZI_DETAIL_LIUYUE_NOT_UNIQUE")
      }))
    };
  });

  return {
    candidateId,
    sourceBaziCandidateFingerprint: computeSourceBaziCandidateFingerprintFromStrict({
      caseId: sources.baseChartSet.caseId,
      candidateId,
      bazi: base.bazi
    }),
    auxiliaryPillars: {
      taiYuan: auxiliaryPillar(eightChar.getTaiYuan(), eightChar.getTaiYuanNaYin()),
      taiXi: auxiliaryPillar(eightChar.getTaiXi(), eightChar.getTaiXiNaYin()),
      baziMingGong: auxiliaryPillar(eightChar.getMingGong(), eightChar.getMingGongNaYin()),
      baziShenGong: auxiliaryPillar(eightChar.getShenGong(), eightChar.getShenGongNaYin())
    },
    daYunDetails: daYun.map((period) => ({
      index: period.getIndex(),
      relations: period.getIndex() === 0
        ? null
        : relations(eightChar, period.getGanZhi(), "BAZI_DETAIL_DAYUN_RELATION_UNAVAILABLE")
    })),
    annualDetails
  };
}

export function buildBaziDetailV1(sources: BaziDetailSourcesV1): BaziDetailV1 {
  const strict = parseStrictBaziDetailSources(sources);
  return withLockedLunarLanguage(() => {
    const body: Omit<BaziDetailV1, "detailFingerprint"> = {
      schemaVersion: "1.0.0",
      rulesetVersion: "CyberSaga-Bazi-Detail-v1",
      engine: BAZI_ENGINE,
      caseId: strict.publicBirthRecord.caseId,
      targetYears: [...strict.baseChartSet.targetYears],
      configuration: {
        annualBoundary: "li_chun",
        monthBoundary: "solar_terms",
        monthInterval: "half_open",
        solarTermTimeBasis: "lunar_typescript_get_jie_qi_table",
        calculationPrecision: "second",
        primaryDisplayPrecision: "minute_truncate",
        maxTargetYears: 50,
        maxDaYunPeriods: 20,
        liuYuePerYear: 12
      },
      sourceIdentity: computeBaziDetailSourceIdentityFromStrict(strict),
      candidates: strict.baseChartSet.candidates.map((candidate) => (
        buildCandidateDetail(strict, candidate.candidateId)
      ))
    };
    const detail = { ...body, detailFingerprint: computeBaziDetailFingerprint(body) };
    return parseBoundBaziDetail({ ...strict, detail });
  });
}

export function intersectCanonicalYearSets(yearSets: readonly (readonly number[])[]): number[] {
  if (yearSets.length === 0) return [];
  const remaining = yearSets.slice(1).map((years) => new Set(years));
  return [...new Set(yearSets[0])]
    .filter((year) => remaining.every((years) => years.has(year)))
    .sort((left, right) => left - right);
}

function baziSupportedYearsForCandidate(
  sources: BaziDetailSourcesV1,
  candidateId: string
): number[] {
  const base = sources.baseChartSet.candidates.find((candidate) => candidate.candidateId === candidateId)!;
  const { daYun } = rebuildCandidate(sources, candidateId);
  const covered = new Set<number>();
  const xiaoYunCounts = new Map<number, number>();
  daYun.forEach((period, index) => {
    const saved = base.bazi.luck.daYun[index];
    const periodLength = saved.endYear - saved.startYear + 1;
    if (!Number.isInteger(periodLength) || periodLength < 1) {
      fail("BAZI_DETAIL_XIAOYUN_NOT_UNIQUE", `${candidateId}: invalid bounded period`);
    }
    for (let year = Math.max(1900, saved.startYear); year <= Math.min(2099, saved.endYear); year += 1) {
      covered.add(year);
    }
    period.getXiaoYun(periodLength).forEach((item) => {
      const year = item.getYear();
      xiaoYunCounts.set(year, (xiaoYunCounts.get(year) ?? 0) + 1);
    });
  });
  return [...covered].filter((year) => xiaoYunCounts.get(year) === 1).sort((left, right) => left - right);
}

export function resolveSharedSupportedTargetYears(sources: BaziDetailSourcesV1): number[] {
  const strict = parseStrictBaziDetailSources(sources);
  return withLockedLunarLanguage(() => intersectCanonicalYearSets(
    strict.baseChartSet.candidates.map((base) => {
      const candidate = strict.timeEvidence.candidates.find((item) => item.id === base.candidateId)!;
      const baziYears = baziSupportedYearsForCandidate(strict, base.candidateId);
      return filterZiweiSupportedTargetYears(strict.publicBirthRecord, candidate, baziYears, base.ziwei);
    })
  ));
}

export function assertTargetYearsWithinSharedSupportedSet(
  targetYears: readonly number[],
  supportedYears: readonly number[]
): number[] {
  const supported = new Set(supportedYears);
  for (const year of targetYears) {
    if (!supported.has(year)) throw new TargetYearOutsideSharedSupportedSetError(year);
  }
  return [...targetYears];
}

export function truncateEngineDateTimeToMinute(engineDateTime: string): string {
  return engineDateTime.slice(0, 16);
}
