import type {
  BaziAnnualFortune,
  BaziDaYun,
  CandidateDualChartV1,
  NormalizedZiweiStar,
  ZiweiHoroscopeItem,
  ZiweiPalace
} from "../charts/types.js";
import type { ReviewJsonValue } from "./contracts/common.js";
import { ReviewJsonValueSchema, compareUnicodeCodePoints } from "./contracts/common.js";
import { ReviewError } from "./errors.js";
import {
  expandComparisonProfile,
  reviewRegistryIdentityForSubject,
  type ResolvedRegisteredField,
  type ReviewField
} from "./registry.js";
import type { ReviewSubject } from "./subject-revision.js";

const EARTHLY_BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"] as const;
const PILLAR_POSITIONS = ["year", "month", "day", "time"] as const;

export interface StableZiweiPalaceIdentityV1 {
  name: string;
  isBodyPalace: boolean;
  isOriginalPalace: boolean;
  heavenlyStem: string;
  earthlyBranch: string;
}

export interface StableZiweiStarIdentityV1 {
  name: string;
  type: string;
  scope: string;
}

export interface StableZiweiYearlyPalaceV1 {
  earthlyBranch: string;
  palaceName: string;
  stars: Array<StableZiweiStarIdentityV1 & {
    brightness: string | null;
    transformation: string | null;
  }>;
}

export interface StableZiweiHoroscopeItemV1 {
  name: string;
  heavenlyStem: string;
  earthlyBranch: string;
  transformations: string[];
  palaces: StableZiweiYearlyPalaceV1[];
}

type ExtractorContext = {
  candidate: CandidateDualChartV1;
  timeCandidate: ReviewSubject["timeEvidence"]["candidates"][number];
  daYunByIndex: Map<number, BaziDaYun>;
  annualByYear: Map<number, BaziAnnualFortune>;
  palaceByBranch: Map<string, ZiweiPalace>;
  palaceByIndex: Map<number, ZiweiPalace>;
  yearlyByYear: Map<number, CandidateDualChartV1["ziwei"]["yearlyFortunes"][number]>;
};

function invalid(code: string, message: string): ReviewError {
  return new ReviewError(code, message, 422);
}

function uniqueBy<T, K extends string | number>(
  values: readonly T[],
  key: (value: T) => K,
  code: string,
  message: string
): Map<K, T> {
  const result = new Map<K, T>();
  for (const value of values) {
    const identity = key(value);
    if (result.has(identity)) throw invalid(code, message);
    result.set(identity, value);
  }
  return result;
}

function assertExactTargetYears(
  targetYears: readonly number[],
  actualYears: readonly number[],
  code: string,
  label: string
): void {
  const expected = [...targetYears].sort((left, right) => left - right);
  const actual = [...actualYears].sort((left, right) => left - right);
  if (
    new Set(actualYears).size !== actualYears.length
    || expected.length !== actual.length
    || expected.some((year, index) => year !== actual[index])
  ) {
    throw invalid(code, `${label} 必须对 targetYears 每年唯一存在`);
  }
}

function buildContext(subject: ReviewSubject, candidateId: string): ExtractorContext {
  if (!subject.retainedCandidateIds.includes(candidateId)) {
    throw invalid("REVIEW_CANDIDATE_NOT_RETAINED", `候选未被核心主体保留: ${candidateId}`);
  }
  const chartCandidates = subject.charts.candidates.filter((item) => item.candidateId === candidateId);
  const timeCandidates = subject.timeEvidence.candidates.filter((item) => item.id === candidateId);
  if (chartCandidates.length !== 1 || timeCandidates.length !== 1) {
    throw invalid("REVIEW_CANDIDATE_NOT_FOUND", `候选必须在 charts/timeEvidence 各唯一存在: ${candidateId}`);
  }
  const candidate = chartCandidates[0];
  const daYunByIndex = uniqueBy(
    candidate.bazi.luck.daYun,
    (item) => item.index,
    "REVIEW_DA_YUN_INDEX_INVALID",
    "大运 index 必须盘内唯一"
  );
  const annualByYear = uniqueBy(
    candidate.bazi.annualFortunes,
    (item) => item.year,
    "REVIEW_ANNUAL_YEAR_INVALID",
    "八字流年 year 必须唯一"
  );
  assertExactTargetYears(
    subject.charts.targetYears,
    candidate.bazi.annualFortunes.map((item) => item.year),
    "REVIEW_ANNUAL_YEAR_INVALID",
    "八字流年"
  );

  const palaceByBranch = uniqueBy(
    candidate.ziwei.palaces,
    (palace) => palace.earthlyBranch,
    "REVIEW_PALACE_BRANCH_INVALID",
    "紫微宫位地支必须唯一"
  );
  const palaceByIndex = uniqueBy(
    candidate.ziwei.palaces,
    (palace) => palace.index,
    "REVIEW_PALACE_INDEX_INVALID",
    "紫微宫位 index 必须唯一"
  );
  if (
    candidate.ziwei.palaces.length !== 12
    || palaceByBranch.size !== 12
    || palaceByIndex.size !== 12
    || EARTHLY_BRANCHES.some((branch) => !palaceByBranch.has(branch))
    || Array.from({ length: 12 }, (_unused, index) => index).some((index) => !palaceByIndex.has(index))
  ) {
    throw invalid("REVIEW_PALACE_IDENTITY_INVALID", "紫微宫位必须具有完整唯一的十二地支和 0..11 index 映射");
  }
  for (const palace of candidate.ziwei.palaces) {
    for (const [kind, stars] of [["major", palace.majorStars], ["minor", palace.minorStars]] as const) {
      if (new Set(stars.map((star) => star.name)).size !== stars.length) {
        throw invalid("REVIEW_STAR_IDENTITY_INVALID", `${palace.earthlyBranch}/${kind} 星名必须唯一`);
      }
    }
  }

  const yearlyByYear = uniqueBy(
    candidate.ziwei.yearlyFortunes,
    (fortune) => fortune.targetYear,
    "REVIEW_ZIWEI_YEAR_INVALID",
    "紫微流年 targetYear 必须唯一"
  );
  assertExactTargetYears(
    subject.charts.targetYears,
    candidate.ziwei.yearlyFortunes.map((item) => item.targetYear),
    "REVIEW_ZIWEI_YEAR_INVALID",
    "紫微流年"
  );
  return {
    candidate,
    timeCandidate: timeCandidates[0],
    daYunByIndex,
    annualByYear,
    palaceByBranch,
    palaceByIndex,
    yearlyByYear
  };
}

function stableStarIdentity(star: NormalizedZiweiStar): StableZiweiStarIdentityV1 {
  return { name: star.name, type: star.type, scope: star.scope };
}

function compareStars(left: NormalizedZiweiStar, right: NormalizedZiweiStar): number {
  return compareUnicodeCodePoints(left.name, right.name)
    || compareUnicodeCodePoints(left.type, right.type)
    || compareUnicodeCodePoints(left.scope, right.scope);
}

export function projectStableHoroscopeItem(
  item: ZiweiHoroscopeItem,
  palaceByIndex: ReadonlyMap<number, ZiweiPalace>
): StableZiweiHoroscopeItemV1 {
  if (item.palaceNames.length !== 12 || item.starsByPalace.length !== 12 || palaceByIndex.size !== 12) {
    throw invalid("REVIEW_YEARLY_PALACE_MAPPING_INVALID", "年度宫名与星曜必须可完整映射十二 natal palace index");
  }
  if (item.transformations.length !== 4 || item.transformations.some((value) => value.length === 0)) {
    throw invalid("REVIEW_YEARLY_TRANSFORMATIONS_INVALID", "年度四化必须保留锁定的禄权科忌四项语义顺序");
  }
  const palaces: StableZiweiYearlyPalaceV1[] = [];
  for (let index = 0; index < 12; index += 1) {
    const natalPalace = palaceByIndex.get(index);
    const palaceName = item.palaceNames[index];
    const sourceStars = item.starsByPalace[index];
    if (natalPalace === undefined || typeof palaceName !== "string" || !Array.isArray(sourceStars)) {
      throw invalid("REVIEW_YEARLY_PALACE_MAPPING_INVALID", `年度宫位无法映射 natal index ${index}`);
    }
    const stableKeys = sourceStars.map((star) => `${star.type}\0${star.name}\0${star.scope}`);
    if (new Set(stableKeys).size !== stableKeys.length) {
      throw invalid("REVIEW_YEARLY_STAR_IDENTITY_INVALID", `${natalPalace.earthlyBranch} 年度宫内星曜稳定键重复`);
    }
    palaces.push({
      earthlyBranch: natalPalace.earthlyBranch,
      palaceName,
      stars: [...sourceStars].sort(compareStars).map((star) => ({
        ...stableStarIdentity(star),
        brightness: star.brightness,
        transformation: star.transformation
      }))
    });
  }
  palaces.sort((left, right) => compareUnicodeCodePoints(left.earthlyBranch, right.earthlyBranch));
  if (new Set(palaces.map((palace) => palace.earthlyBranch)).size !== 12) {
    throw invalid("REVIEW_YEARLY_PALACE_MAPPING_INVALID", "年度宫位稳定地支重复");
  }
  return {
    name: item.name,
    heavenlyStem: item.heavenlyStem,
    earthlyBranch: item.earthlyBranch,
    transformations: [...item.transformations],
    palaces
  };
}

function starForField(
  context: ExtractorContext,
  field: ResolvedRegisteredField
): NormalizedZiweiStar {
  const branch = field.parameters.earthlyBranch;
  const kind = field.parameters.starKind;
  const name = field.parameters.starName;
  const palace = context.palaceByBranch.get(branch);
  const stars = kind === "major" ? palace?.majorStars : kind === "minor" ? palace?.minorStars : undefined;
  const matches = stars?.filter((star) => star.name === name) ?? [];
  if (matches.length !== 1) {
    throw invalid("REVIEW_STAR_IDENTITY_INVALID", `星曜必须由宫支/类别/星名唯一定位: ${field.fieldPath}`);
  }
  return matches[0];
}

function valueForField(
  subject: ReviewSubject,
  context: ExtractorContext,
  field: ResolvedRegisteredField
): ReviewJsonValue {
  const { candidate, timeCandidate } = context;
  if (subject.subjectContract !== "location_time_v1") {
    const providedCandidate = subject.timeEvidence.candidates.find((item) => item.id === timeCandidate.id);
    if (providedCandidate === undefined) throw invalid("REVIEW_CANDIDATE_NOT_FOUND", timeCandidate.id);
    switch (field.pathTemplate) {
      case "time.input.calendar": return { ...subject.timeEvidence.originalCalendar };
      case "time.input.localTime": return subject.timeEvidence.originalLocalTime;
      case "time.input.basis": return subject.timeEvidence.originalTimeBasis;
      case "time.candidate.basis": return providedCandidate.basis;
      case "time.candidate.localDateTime": return providedCandidate.localDateTime;
      case "time.candidate.earthlyBranch": return providedCandidate.earthlyBranch.name;
      case "time.candidate.ziSegment": return providedCandidate.ziSegment;
      case "time.candidate.dayBoundary": return providedCandidate.dayBoundary;
      case "time.candidate.calendarBasis": return providedCandidate.calendarBasis;
      case "time.candidate.warnings": return [...providedCandidate.warnings];
    }
    if (field.pathTemplate.startsWith("time.")) {
      throw invalid("REVIEW_FIELD_EXTRACTOR_MISSING", `V2 不允许地点或时区字段: ${field.fieldPath}`);
    }
  }
  const legacyEvidence = subject.subjectContract === "location_time_v1" ? subject.timeEvidence : undefined;
  const legacyCandidate = legacyEvidence?.candidates.find((item) => item.id === timeCandidate.id);
  const trueSolar = legacyCandidate?.trueSolarCorrection;
  switch (field.pathTemplate) {
    case "time.original.calendar": return { ...subject.timeEvidence.originalCalendar };
    case "time.original.localTime": return subject.timeEvidence.originalLocalTime;
    case "time.zone.timeZone": return legacyEvidence?.timeZone ?? null;
    case "time.zone.standardOffsetMinutes": return legacyEvidence?.standardOffsetMinutes ?? null;
    case "time.location.latitude": return legacyEvidence?.latitude ?? null;
    case "time.location.longitude": return legacyEvidence?.longitude ?? null;
    case "time.location.clockConvention": return legacyEvidence?.clockConvention ?? null;
    case "time.candidate.basis": return timeCandidate.basis;
    case "time.candidate.localDateTime": return timeCandidate.localDateTime;
    case "time.candidate.instant": return legacyCandidate?.instant ?? null;
    case "time.candidate.offset": return legacyCandidate?.offset ?? null;
    case "time.candidate.standardOffset": return legacyCandidate?.standardOffset ?? null;
    case "time.candidate.dstMinutes": return legacyCandidate?.dstMinutes ?? null;
    case "time.candidate.earthlyBranch": return timeCandidate.earthlyBranch.name;
    case "time.candidate.ziSegment": return timeCandidate.ziSegment;
    case "time.candidate.dayBoundary": return timeCandidate.dayBoundary;
    case "time.candidate.calendarBasis": return timeCandidate.calendarBasis ?? null;
    case "time.candidate.trueSolar.clockLocalDateTime": return trueSolar?.clockLocalDateTime ?? null;
    case "time.candidate.trueSolar.standardLocalDateTime": return trueSolar?.standardLocalDateTime ?? null;
    case "time.candidate.trueSolar.dstRemovedMinutes": return trueSolar?.dstRemovedMinutes ?? null;
    case "time.candidate.trueSolar.longitude": return trueSolar?.longitude ?? null;
    case "time.candidate.trueSolar.standardMeridian": return trueSolar?.standardMeridian ?? null;
    case "time.candidate.trueSolar.longitudeCorrectionMinutes": return trueSolar?.longitudeCorrectionMinutes ?? null;
    case "time.candidate.trueSolar.equationOfTimeMinutes": return trueSolar?.equationOfTimeMinutes ?? null;
    case "time.candidate.trueSolar.totalCorrectionMinutes": return trueSolar?.totalCorrectionMinutes ?? null;
    case "time.candidate.trueSolar.adjustedLocalDateTime": return trueSolar?.adjustedLocalDateTime ?? null;
    case "time.candidate.warnings": return [...timeCandidate.warnings];
    case "bazi.fourPillars": return [...candidate.bazi.fourPillars];
    case "bazi.luck.forward": return candidate.bazi.luck.forward;
    case "bazi.luck.startSolarDateTime": return candidate.bazi.luck.startSolarDateTime;
    case "bazi.luck.startAfter": return { ...candidate.bazi.luck.startAfter };
    case "ziwei.soulPalaceBranch": return candidate.ziwei.soulPalaceBranch;
    case "ziwei.bodyPalaceBranch": return candidate.ziwei.bodyPalaceBranch;
    case "ziwei.soul": return candidate.ziwei.soul;
    case "ziwei.body": return candidate.ziwei.body;
    case "ziwei.fiveElementsClass": return candidate.ziwei.fiveElementsClass;
    case "ziwei.transformations":
      return candidate.ziwei.transformations.map((item) => {
        const palace = context.palaceByIndex.get(item.palaceIndex);
        if (palace === undefined || item.palaceName !== palace.name) {
          throw invalid("REVIEW_TRANSFORMATION_PALACE_INVALID", `本命四化 palaceIndex 无法稳定映射: ${item.palaceIndex}`);
        }
        return {
          palaceBranch: palace.earthlyBranch,
          palaceName: palace.name,
          starName: item.starName,
          transformation: item.transformation
        };
      }).sort((left, right) => (
        compareUnicodeCodePoints(left.palaceBranch, right.palaceBranch)
        || compareUnicodeCodePoints(left.starName, right.starName)
        || compareUnicodeCodePoints(left.transformation, right.transformation)
      ));
  }

  if (field.expansion === "pillar_position") {
    const position = field.parameters.position as typeof PILLAR_POSITIONS[number];
    if (!PILLAR_POSITIONS.includes(position)) throw invalid("REVIEW_PILLAR_POSITION_INVALID", field.fieldPath);
    const pillar = candidate.bazi.pillars[position];
    switch (field.pathTemplate.split(".").at(-1)) {
      case "ganZhi": return pillar.ganZhi;
      case "hiddenStems": return [...pillar.hiddenStems];
      case "stemTenGod": return pillar.stemTenGod;
      case "hiddenStemTenGods": return [...pillar.hiddenStemTenGods];
      case "naYin": return pillar.naYin;
      case "xun": return pillar.xun;
      case "voidBranches": return pillar.voidBranches;
      case "growthStage": return pillar.growthStage;
    }
  }

  if (field.expansion === "da_yun") {
    const index = Number(field.parameters.daYunIndex);
    const daYun = context.daYunByIndex.get(index);
    if (daYun === undefined) throw invalid("REVIEW_DA_YUN_INDEX_INVALID", `大运 index 不存在: ${index}`);
    switch (field.pathTemplate.split(".").at(-1)) {
      case "period": return {
        startAge: daYun.startAge,
        endAge: daYun.endAge,
        startYear: daYun.startYear,
        endYear: daYun.endYear
      };
      case "ganZhi": return daYun.ganZhi;
      case "xun": return daYun.xun;
      case "voidBranches": return daYun.voidBranches;
    }
  }

  if (field.pathTemplate === "bazi.annualFortune.{targetYear}") {
    const year = Number(field.parameters.targetYear);
    const annual = context.annualByYear.get(year);
    if (annual === undefined) throw invalid("REVIEW_ANNUAL_YEAR_INVALID", `八字流年缺少: ${year}`);
    return {
      year: annual.year,
      age: annual.age,
      ganZhi: annual.ganZhi,
      xun: annual.xun,
      voidBranches: annual.voidBranches,
      daYunIndex: annual.daYunIndex
    };
  }

  if (field.expansion === "palace_branch") {
    const palace = context.palaceByBranch.get(field.parameters.earthlyBranch);
    if (palace === undefined) throw invalid("REVIEW_PALACE_BRANCH_INVALID", field.fieldPath);
    switch (field.pathTemplate.split(".").at(-1)) {
      case "identity": return {
        name: palace.name,
        isBodyPalace: palace.isBodyPalace,
        isOriginalPalace: palace.isOriginalPalace,
        heavenlyStem: palace.heavenlyStem,
        earthlyBranch: palace.earthlyBranch
      } satisfies StableZiweiPalaceIdentityV1;
      case "majorStarNames": return palace.majorStars.map((star) => star.name).sort(compareUnicodeCodePoints);
      case "minorStarNames": return palace.minorStars.map((star) => star.name).sort(compareUnicodeCodePoints);
      case "changsheng12": return palace.changsheng12;
      case "decadal": return {
        startAge: palace.decadal.startAge,
        endAge: palace.decadal.endAge,
        heavenlyStem: palace.decadal.heavenlyStem,
        earthlyBranch: palace.decadal.earthlyBranch
      };
      case "ages": return [...palace.ages];
    }
  }

  if (field.expansion === "palace_star") {
    const star = starForField(context, field);
    switch (field.pathTemplate.split(".").at(-1)) {
      case "identity": return { name: star.name, type: star.type, scope: star.scope };
      case "brightness": return star.brightness;
      case "transformation": return star.transformation;
    }
  }

  if (field.pathTemplate.startsWith("ziwei.yearlyFortune.")) {
    const year = Number(field.parameters.targetYear);
    const fortune = context.yearlyByYear.get(year);
    if (fortune === undefined) throw invalid("REVIEW_ZIWEI_YEAR_INVALID", `紫微流年缺少: ${year}`);
    const item = field.pathTemplate.endsWith(".decadal") ? fortune.decadal : fortune.yearly;
    return projectStableHoroscopeItem(item, context.palaceByIndex) as unknown as ReviewJsonValue;
  }
  throw invalid("REVIEW_FIELD_EXTRACTOR_MISSING", `已注册字段缺少提取器: ${field.fieldPath}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRegisteredValueType(valueType: ReviewField["valueType"], value: unknown): boolean {
  const finiteNumber = (item: unknown) => typeof item === "number" && Number.isFinite(item);
  switch (valueType) {
    case "string": return typeof value === "string";
    case "number": return finiteNumber(value);
    case "boolean": return typeof value === "boolean";
    case "nullable_string": return value === null || typeof value === "string";
    case "nullable_number": return value === null || finiteNumber(value);
    case "string_array": return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "number_array": return Array.isArray(value) && value.every(finiteNumber);
    case "object": return isPlainObject(value);
    case "nullable_object": return value === null || isPlainObject(value);
    case "object_array": return Array.isArray(value) && value.every(isPlainObject);
  }
}

export function assertRegisteredValue(
  field: Pick<ResolvedRegisteredField, "fieldPath" | "valueType">,
  value: unknown
): asserts value is ReviewJsonValue {
  if (!ReviewJsonValueSchema.safeParse(value).success || !isRegisteredValueType(field.valueType, value)) {
    throw invalid(
      "REVIEW_FIELD_VALUE_INVALID",
      `${field.fieldPath} 必须符合注册 valueType=${field.valueType}`
    );
  }
}

export async function extractRegisteredFields(
  subject: ReviewSubject,
  candidateId: string
): Promise<Map<string, ReviewJsonValue>> {
  const context = buildContext(subject, candidateId);
  const registry = reviewRegistryIdentityForSubject(subject);
  const profile = await expandComparisonProfile(registry.version, subject.charts, candidateId);
  const result = new Map<string, ReviewJsonValue>();
  for (const field of profile) {
    const value = valueForField(subject, context, field);
    assertRegisteredValue(field, value);
    if (result.has(field.fieldPath)) {
      throw invalid("REVIEW_FIELD_DUPLICATE", `字段提取结果重复: ${field.fieldPath}`);
    }
    result.set(field.fieldPath, value);
  }
  if (result.size !== profile.length) {
    throw invalid("REVIEW_FIELD_PROFILE_INCOMPLETE", "字段提取结果与 profile expansion 不一致");
  }
  return result;
}
