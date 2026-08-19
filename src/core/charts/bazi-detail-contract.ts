import { LocalDateTime } from "@js-joda/core";
import { z } from "zod";

import type { BaziChartV1 } from "./types.js";

const CASE_ID = z.string().regex(/^CS-\d{4}-\d{3}$/u);
const SHA256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const GAN = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"] as const;
const ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"] as const;
const GAN_ZHI_TEXT = z.string().length(2).refine((value) => {
  const stemIndex = GAN.indexOf(value[0] as typeof GAN[number]);
  const branchIndex = ZHI.indexOf(value[1] as typeof ZHI[number]);
  return stemIndex >= 0 && branchIndex >= 0 && stemIndex % 2 === branchIndex % 2;
}, "干支必须属于六十甲子");
// The locked engine reports the day stem as 日主 rather than a relative ten-god.
const TEN_GOD = z.enum(["比肩", "劫财", "食神", "伤官", "偏财", "正财", "七杀", "正官", "偏印", "正印", "日主"]);
const NA_YIN = z.enum(["海中金", "炉中火", "大林木", "路旁土", "剑锋金", "山头火", "涧下水", "城头土", "白蜡金", "杨柳木", "泉中水", "屋上土", "霹雳火", "松柏木", "长流水", "沙中金", "山下火", "平地木", "壁上土", "金箔金", "覆灯火", "天河水", "大驿土", "钗钏金", "桑柘木", "大溪水", "沙中土", "天上火", "石榴木", "大海水"]);
const GROWTH_STAGE = z.enum(["长生", "沐浴", "冠带", "临官", "帝旺", "衰", "病", "死", "墓", "绝", "胎", "养"]);
const XUN = z.enum(["甲子", "甲戌", "甲申", "甲午", "甲辰", "甲寅"]);
const VOID_BRANCHES = z.string().regex(/^[子丑寅卯辰巳午未申酉戌亥]{2}$/u);
const JIE_QI = ["立春", "惊蛰", "清明", "立夏", "芒种", "小暑", "立秋", "白露", "寒露", "立冬", "大雪", "小寒"] as const;
const MONTH_NAMES = ["寅月", "卯月", "辰月", "巳月", "午月", "未月", "申月", "酉月", "戌月", "亥月", "子月", "丑月"] as const;
const engineDateTime = z.string().superRefine((value, context) => {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) {
    context.addIssue({ code: "custom", message: "engineDateTime 必须使用 YYYY-MM-DD HH:mm:ss" });
    return;
  }
  try { LocalDateTime.parse(value.replace(" ", "T")); } catch {
    context.addIssue({ code: "custom", message: "engineDateTime 必须是有效本地日期时间" });
  }
});

function sortedUnique<T>(values: readonly T[], key: (value: T) => string | number): boolean {
  return values.every((value, index) => index === 0 || key(values[index - 1]) < key(value));
}

export interface BaziGanZhiRelationsV1 { stemTenGod: string; branchMainQiTenGod: string; hiddenStems: string[]; hiddenStemTenGods: string[]; growthStage: string; naYin: string; }
export interface BaziAuxiliaryPillarV1 { ganZhi: string; naYin: string; }
export interface BaziDaYunDetailV1 { index: number; relations: BaziGanZhiRelationsV1 | null; }
export interface BaziXiaoYunDetailV1 { year: number; virtualAge: number; ganZhi: string; xun: string; voidBranches: string; relations: BaziGanZhiRelationsV1; }
export interface EngineSolarTermBoundaryV1 { name: typeof JIE_QI[number]; engineDateTime: string; }
export interface BaziLiuYueDetailV1 { ordinal: number; monthName: string; interval: { start: EngineSolarTermBoundaryV1; end: EngineSolarTermBoundaryV1; semantics: "half_open"; }; ganZhi: string; xun: string; voidBranches: string; relations: BaziGanZhiRelationsV1; }
export interface BaziAnnualDetailV1 { year: number; daYunIndex: number; relations: BaziGanZhiRelationsV1; xiaoYun: BaziXiaoYunDetailV1; liuYue: BaziLiuYueDetailV1[]; }
export interface BaziDetailCandidateV1 { candidateId: string; sourceBaziCandidateFingerprint: `sha256:${string}`; auxiliaryPillars: { taiYuan: BaziAuxiliaryPillarV1; taiXi: BaziAuxiliaryPillarV1; baziMingGong: BaziAuxiliaryPillarV1; baziShenGong: BaziAuxiliaryPillarV1; }; daYunDetails: BaziDaYunDetailV1[]; annualDetails: BaziAnnualDetailV1[]; }
export interface BaziDetailV1 { schemaVersion: "1.0.0"; rulesetVersion: "CyberSaga-Bazi-Detail-v1"; engine: { name: "lunar-typescript"; version: "1.8.6"; }; caseId: string; targetYears: number[]; configuration: { annualBoundary: "li_chun"; monthBoundary: "solar_terms"; monthInterval: "half_open"; solarTermTimeBasis: "lunar_typescript_get_jie_qi_table"; calculationPrecision: "second"; primaryDisplayPrecision: "minute_truncate"; maxTargetYears: 50; maxDaYunPeriods: 20; liuYuePerYear: 12; }; sourceIdentity: { publicBirthRecordFingerprint: `sha256:${string}`; timeEvidenceFingerprint: `sha256:${string}`; baseBaziProjectionFingerprint: `sha256:${string}`; targetYearsFingerprint: `sha256:${string}`; }; candidates: BaziDetailCandidateV1[]; detailFingerprint: `sha256:${string}`; }

export const BaziGanZhiRelationsV1Schema = z.object({
  stemTenGod: TEN_GOD, branchMainQiTenGod: TEN_GOD, hiddenStems: z.array(z.enum(GAN)), hiddenStemTenGods: z.array(TEN_GOD), growthStage: GROWTH_STAGE, naYin: NA_YIN
}).strict().superRefine((value, context) => {
  if (value.hiddenStems.length !== value.hiddenStemTenGods.length) context.addIssue({ code: "custom", message: "藏干与副星长度必须一致", path: ["hiddenStemTenGods"] });
});
const auxiliary = z.object({ ganZhi: GAN_ZHI_TEXT, naYin: NA_YIN }).strict();
const sourcePillar = z.object({ ganZhi: GAN_ZHI_TEXT, heavenlyStem: z.enum(GAN), earthlyBranch: z.enum(ZHI), hiddenStems: z.array(z.enum(GAN)), stemTenGod: TEN_GOD, hiddenStemTenGods: z.array(TEN_GOD), naYin: NA_YIN, xun: XUN, voidBranches: VOID_BRANCHES, growthStage: GROWTH_STAGE }).strict().superRefine((value, context) => {
  if (value.hiddenStems.length !== value.hiddenStemTenGods.length) context.addIssue({ code: "custom", message: "基础盘藏干与副星长度必须一致" });
});
const boundary = z.object({ name: z.enum(JIE_QI), engineDateTime }).strict();
const liuYue = z.object({ ordinal: z.number().int().min(1).max(12), monthName: z.string().min(1), interval: z.object({ start: boundary, end: boundary, semantics: z.literal("half_open") }).strict(), ganZhi: GAN_ZHI_TEXT, xun: XUN, voidBranches: VOID_BRANCHES, relations: BaziGanZhiRelationsV1Schema }).strict();
const annual = z.object({ year: z.number().int().min(1900).max(2099), daYunIndex: z.number().int().min(0).max(20), relations: BaziGanZhiRelationsV1Schema, xiaoYun: z.object({ year: z.number().int().min(1900).max(2099), virtualAge: z.number().int().min(0), ganZhi: GAN_ZHI_TEXT, xun: XUN, voidBranches: VOID_BRANCHES, relations: BaziGanZhiRelationsV1Schema }).strict(), liuYue: z.array(liuYue).length(12) }).strict().superRefine((value, context) => {
  if (value.xiaoYun.year !== value.year) context.addIssue({ code: "custom", message: "小运年份必须与流年一致", path: ["xiaoYun", "year"] });
  const months = value.liuYue;
  months.forEach((month, index) => {
    if (month.ordinal !== index + 1 || month.monthName !== MONTH_NAMES[index] || month.interval.start.name !== JIE_QI[index] || month.interval.end.name !== JIE_QI[(index + 1) % 12]) context.addIssue({ code: "custom", message: "流月必须使用固定节气与月份顺序", path: ["liuYue", index] });
    if (month.interval.start.engineDateTime >= month.interval.end.engineDateTime) context.addIssue({ code: "custom", message: "流月区间必须递增", path: ["liuYue", index, "interval"] });
    if (index > 0 && months[index - 1].interval.end.engineDateTime !== month.interval.start.engineDateTime) context.addIssue({ code: "custom", message: "流月区间必须连续", path: ["liuYue", index, "interval", "start"] });
  });
  if (months.length === 12) {
    if (!months[0].interval.start.engineDateTime.startsWith(`${value.year}-`) || months[0].interval.start.name !== "立春") context.addIssue({ code: "custom", message: "首月必须从目标年立春开始", path: ["liuYue", 0] });
    if (!months[11].interval.end.engineDateTime.startsWith(`${value.year + 1}-`) || months[11].interval.end.name !== "立春") context.addIssue({ code: "custom", message: "末月必须在次年立春结束", path: ["liuYue", 11] });
  }
});
export const BaziDetailCandidateV1Schema = z.object({ candidateId: z.string().min(1), sourceBaziCandidateFingerprint: SHA256, auxiliaryPillars: z.object({ taiYuan: auxiliary, taiXi: auxiliary, baziMingGong: auxiliary, baziShenGong: auxiliary }).strict(), daYunDetails: z.array(z.object({ index: z.number().int().min(0).max(20), relations: BaziGanZhiRelationsV1Schema.nullable() }).strict()).max(20), annualDetails: z.array(annual) }).strict().superRefine((value, context) => {
  if (!sortedUnique(value.daYunDetails, (item) => item.index)) context.addIssue({ code: "custom", message: "大运 index 必须严格递增且唯一", path: ["daYunDetails"] });
  value.daYunDetails.forEach((item, index) => { if ((item.index === 0) !== (item.relations === null)) context.addIssue({ code: "custom", message: "行运前大运必须且只能使用 null 关系", path: ["daYunDetails", index, "relations"] }); });
  if (!sortedUnique(value.annualDetails, (item) => `${item.year}:${String(item.daYunIndex).padStart(2, "0")}`)) context.addIssue({ code: "custom", message: "流年键必须严格递增且唯一", path: ["annualDetails"] });
});

export const BaziDetailV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"), rulesetVersion: z.literal("CyberSaga-Bazi-Detail-v1"), engine: z.object({ name: z.literal("lunar-typescript"), version: z.literal("1.8.6") }).strict(), caseId: CASE_ID,
  targetYears: z.array(z.number().int().min(1900).max(2099)).max(50), configuration: z.object({ annualBoundary: z.literal("li_chun"), monthBoundary: z.literal("solar_terms"), monthInterval: z.literal("half_open"), solarTermTimeBasis: z.literal("lunar_typescript_get_jie_qi_table"), calculationPrecision: z.literal("second"), primaryDisplayPrecision: z.literal("minute_truncate"), maxTargetYears: z.literal(50), maxDaYunPeriods: z.literal(20), liuYuePerYear: z.literal(12) }).strict(),
  sourceIdentity: z.object({ publicBirthRecordFingerprint: SHA256, timeEvidenceFingerprint: SHA256, baseBaziProjectionFingerprint: SHA256, targetYearsFingerprint: SHA256 }).strict(), candidates: z.array(BaziDetailCandidateV1Schema), detailFingerprint: SHA256
}).strict().superRefine((value, context) => {
  if (!sortedUnique(value.targetYears, (year) => year)) context.addIssue({ code: "custom", message: "targetYears 必须严格递增且唯一", path: ["targetYears"] });
  if (!sortedUnique(value.candidates, (item) => item.candidateId)) context.addIssue({ code: "custom", message: "候选必须按 ID 严格递增且唯一", path: ["candidates"] });
});

// This is intentionally a source-only parser: it locks the base Bazi value before a
// detail fingerprint is calculated, without turning the base chart into a new stored schema.
export const StrictCompleteBaziChartV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"), rulesetVersion: z.literal("CyberSaga-Bazi-v1"), candidateId: z.string().min(1), engine: z.object({ name: z.literal("lunar-typescript"), version: z.literal("1.8.6") }).strict(),
  configuration: z.object({ pillarSect: z.union([z.literal(1), z.literal(2)]), luckSect: z.literal(1), yearBoundary: z.literal("li_chun"), monthBoundary: z.literal("solar_terms"), sourceDayBoundary: z.enum(["current", "forward"]) }).strict(),
  input: z.object({ sourceLocalDateTime: z.string(), calculationLocalDateTime: z.string(), timeBasis: z.literal("civil_clock_provided").or(z.literal("apparent_solar_provided")), earthlyBranchIndex: z.number().int().min(0).max(11) }).strict(),
  calendar: z.object({ solarDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), solarDateTime: z.string().min(1), lunarYear: z.number().int(), lunarMonth: z.number().int().min(1).max(12), lunarDay: z.number().int().min(1).max(30), isLeapMonth: z.boolean(), lunarText: z.string().min(1) }).strict(),
  fourPillars: z.tuple([GAN_ZHI_TEXT, GAN_ZHI_TEXT, GAN_ZHI_TEXT, GAN_ZHI_TEXT]), pillars: z.object({ year: sourcePillar, month: sourcePillar, day: sourcePillar, time: sourcePillar }).strict(),
  luck: z.object({ genderCode: z.union([z.literal(0), z.literal(1)]), forward: z.boolean(), startSolarDateTime: z.string().min(1), startAfter: z.object({ years: z.number().int().min(0), months: z.number().int().min(0), days: z.number().int().min(0), hours: z.number().int().min(0) }).strict(), daYun: z.array(z.object({ index: z.number().int().min(0).max(20), startAge: z.number().int().min(0), endAge: z.number().int().min(0), startYear: z.number().int(), endYear: z.number().int(), ganZhi: GAN_ZHI_TEXT.nullable(), xun: XUN.nullable(), voidBranches: VOID_BRANCHES.nullable() }).strict()).min(1).max(20) }).strict(),
  annualFortunes: z.array(z.object({ year: z.number().int(), age: z.number().int().min(0), ganZhi: GAN_ZHI_TEXT, xun: XUN, voidBranches: VOID_BRANCHES, daYunIndex: z.number().int().min(0).max(20) }).strict())
}).strict().superRefine((value, context) => {
  if (!sortedUnique(value.luck.daYun, (item) => item.index)) context.addIssue({ code: "custom", message: "基础大运 index 必须严格递增且唯一", path: ["luck", "daYun"] });
  value.luck.daYun.forEach((item, index) => {
    if (item.index !== index) context.addIssue({ code: "custom", message: "基础大运 index 必须从 0 连续编号", path: ["luck", "daYun", index, "index"] });
  });
  if (!sortedUnique(value.annualFortunes, (item) => `${item.year}:${String(item.daYunIndex).padStart(2, "0")}`)) context.addIssue({ code: "custom", message: "基础流年必须严格递增且唯一", path: ["annualFortunes"] });
  const pillars = [value.pillars.year.ganZhi, value.pillars.month.ganZhi, value.pillars.day.ganZhi, value.pillars.time.ganZhi];
  if (value.fourPillars.some((pillar, index) => pillar !== pillars[index])) context.addIssue({ code: "custom", message: "基础四柱必须与柱明细一致", path: ["fourPillars"] });
}) as z.ZodType<BaziChartV1>;

const ziweiStar = z.object({ name: z.string().min(1), type: z.string().min(1), scope: z.string().min(1), brightness: z.string().nullable(), transformation: z.string().nullable() }).strict();
const ziweiPalace = z.object({ index: z.number().int().min(0).max(11), name: z.string().min(1), isBodyPalace: z.boolean(), isOriginalPalace: z.boolean(), heavenlyStem: z.enum(GAN), earthlyBranch: z.enum(ZHI), majorStars: z.array(ziweiStar), minorStars: z.array(ziweiStar), changsheng12: GROWTH_STAGE, decadal: z.object({ startAge: z.number().int().min(0), endAge: z.number().int().min(0), heavenlyStem: z.enum(GAN), earthlyBranch: z.enum(ZHI) }).strict(), ages: z.array(z.number().int().min(0)) }).strict();
const ziweiHoroscope = z.object({ index: z.number().int(), name: z.string().min(1), heavenlyStem: z.enum(GAN), earthlyBranch: z.enum(ZHI), palaceNames: z.array(z.string().min(1)).length(12), transformations: z.array(z.string().min(1)).length(4), starsByPalace: z.array(z.array(ziweiStar)).length(12) }).strict();
const ziweiYearlyFortune = z.object({ targetYear: z.number().int(), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), solarDate: z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/u), lunarDate: z.string().min(1), decadal: ziweiHoroscope, yearly: ziweiHoroscope }).strict();
export const StrictZiweiChartV1Schema = z.object({
  schemaVersion: z.literal("1.0.0"), rulesetVersion: z.literal("CyberSaga-Ziwei-v1"), candidateId: z.string().min(1), engine: z.object({ name: z.literal("iztro"), version: z.literal("2.5.8") }).strict(),
  configuration: z.object({ algorithm: z.literal("default"), yearDivide: z.literal("normal"), horoscopeDivide: z.literal("normal"), ageDivide: z.literal("normal"), dayDivide: z.literal("current"), mutagens: z.literal("iztro-2.5.8-default"), brightness: z.literal("iztro-2.5.8-default"), astroType: z.literal("heaven"), fixLeap: z.literal(true), language: z.literal("zh-CN"), sourceTimeIndex: z.number().int().min(0).max(12), timeIndex: z.number().int().min(0).max(12) }).strict(),
  input: z.object({ sourceLocalDateTime: z.string(), calculationLocalDateTime: z.string(), timeBasis: z.enum(["apparent_solar_provided", "civil_clock_provided"]), sourceZiSegment: z.enum(["early", "late"]).nullable(), sourceDayBoundary: z.enum(["current", "forward"]), engineInputDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u) }).strict(), gender: z.enum(["男", "女"]), solarDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), lunarDate: z.string().min(1), chineseDate: z.string().min(1), time: z.string().min(1), timeRange: z.string().min(1), soulPalaceBranch: z.enum(ZHI), bodyPalaceBranch: z.enum(ZHI), soul: z.string().min(1), body: z.string().min(1), fiveElementsClass: z.string().min(1), palaces: z.array(ziweiPalace).length(12), transformations: z.array(z.object({ palaceIndex: z.number().int().min(0).max(11), palaceName: z.string().min(1), starName: z.string().min(1), transformation: z.string().min(1) }).strict()).length(4), yearlyFortunes: z.array(ziweiYearlyFortune)
}).strict();

export const BaziDetailBaseChartSetSourceSchema = z.object({
  schemaVersion: z.literal("1.0.0"), caseId: CASE_ID, timeRulesetVersion: z.literal("CyberSaga-Provided-Time-v1"), engineVersions: z.object({ bazi: z.object({ name: z.literal("lunar-typescript"), version: z.literal("1.8.6") }).strict(), ziwei: z.object({ name: z.literal("iztro"), version: z.literal("2.5.8") }).strict() }).strict(), chartRulesetVersions: z.object({ bazi: z.literal("CyberSaga-Bazi-v1"), ziwei: z.literal("CyberSaga-Ziwei-v1") }).strict(), targetYears: z.array(z.number().int().min(1900).max(2099)).max(50), candidates: z.array(z.object({ candidateId: z.string().min(1), basis: z.enum(["apparent_solar_provided", "civil_clock_provided"]), dayBoundary: z.enum(["current", "forward"]), calendarResolutionId: z.string().min(1), calendarBasis: z.enum(["solar", "lunar_regular", "lunar_leap"]), bazi: StrictCompleteBaziChartV1Schema, ziwei: StrictZiweiChartV1Schema }).strict()).min(1)
}).strict();
