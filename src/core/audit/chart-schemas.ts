import { z } from "zod";

const NON_EMPTY = z.string().min(1);
const LOCAL_DATE_TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u);
const SOLAR_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const ENGINE_SOLAR_DATE = z.string().regex(/^\d{4}-\d{1,2}-\d{1,2}$/u);
const CANDIDATE_BASIS = z.enum([
  "civil_iana",
  "civil_standard",
  "gap_before",
  "gap_after",
  "apparent_solar",
  "apparent_solar_provided",
  "civil_clock_provided"
]);
const DAY_BOUNDARY = z.enum(["current", "forward"]);
const CALENDAR_BASIS = z.enum(["solar", "lunar_regular", "lunar_leap"]);

export const EngineIdentityAuditSchema = z.object({
  name: NON_EMPTY,
  version: NON_EMPTY
}).strict();

const BaziPillarSchema = z.object({
  ganZhi: NON_EMPTY,
  heavenlyStem: NON_EMPTY,
  earthlyBranch: NON_EMPTY,
  hiddenStems: z.array(NON_EMPTY),
  stemTenGod: NON_EMPTY,
  hiddenStemTenGods: z.array(NON_EMPTY),
  naYin: NON_EMPTY,
  xun: NON_EMPTY,
  voidBranches: z.string(),
  growthStage: NON_EMPTY
}).strict();

const BaziDaYunSchema = z.object({
  index: z.number().int().min(0),
  startAge: z.number().int().min(0),
  endAge: z.number().int().min(0),
  startYear: z.number().int(),
  endYear: z.number().int(),
  ganZhi: NON_EMPTY.nullable(),
  xun: NON_EMPTY.nullable(),
  voidBranches: z.string().nullable()
}).strict();

const BaziAnnualFortuneSchema = z.object({
  year: z.number().int(),
  age: z.number().int().min(0),
  ganZhi: NON_EMPTY,
  xun: NON_EMPTY,
  voidBranches: z.string(),
  daYunIndex: z.number().int().min(0)
}).strict();

export const BaziChartAuditSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  rulesetVersion: NON_EMPTY,
  candidateId: NON_EMPTY,
  engine: EngineIdentityAuditSchema,
  configuration: z.object({
    pillarSect: z.union([z.literal(1), z.literal(2)]),
    luckSect: z.literal(1),
    yearBoundary: NON_EMPTY,
    monthBoundary: NON_EMPTY,
    sourceDayBoundary: DAY_BOUNDARY
  }).strict(),
  input: z.object({
    sourceLocalDateTime: LOCAL_DATE_TIME,
    calculationLocalDateTime: LOCAL_DATE_TIME,
    timeBasis: CANDIDATE_BASIS,
    earthlyBranchIndex: z.number().int().min(0).max(11)
  }).strict(),
  calendar: z.object({
    solarDate: SOLAR_DATE,
    solarDateTime: NON_EMPTY,
    lunarYear: z.number().int(),
    lunarMonth: z.number().int().min(1).max(12),
    lunarDay: z.number().int().min(1).max(30),
    isLeapMonth: z.boolean(),
    lunarText: NON_EMPTY
  }).strict(),
  fourPillars: z.tuple([NON_EMPTY, NON_EMPTY, NON_EMPTY, NON_EMPTY]),
  pillars: z.object({
    year: BaziPillarSchema,
    month: BaziPillarSchema,
    day: BaziPillarSchema,
    time: BaziPillarSchema
  }).strict(),
  luck: z.object({
    genderCode: z.union([z.literal(0), z.literal(1)]),
    forward: z.boolean(),
    startSolarDateTime: NON_EMPTY,
    startAfter: z.object({
      years: z.number().int().min(0),
      months: z.number().int().min(0),
      days: z.number().int().min(0),
      hours: z.number().int().min(0)
    }).strict(),
    daYun: z.array(BaziDaYunSchema).min(1)
  }).strict(),
  annualFortunes: z.array(BaziAnnualFortuneSchema)
}).strict().superRefine((chart, context) => {
  const pillarValues = [
    chart.pillars.year.ganZhi,
    chart.pillars.month.ganZhi,
    chart.pillars.day.ganZhi,
    chart.pillars.time.ganZhi
  ];
  if (chart.fourPillars.some((pillar, index) => pillar !== pillarValues[index])) {
    context.addIssue({
      code: "custom",
      message: "BAZI_FOUR_PILLARS_INCONSISTENT",
      path: ["fourPillars"]
    });
  }
});

const ZiweiStarSchema = z.object({
  name: NON_EMPTY,
  type: NON_EMPTY,
  scope: NON_EMPTY,
  brightness: z.string().nullable(),
  transformation: z.string().nullable()
}).strict();

const ZiweiPalaceSchema = z.object({
  index: z.number().int().min(0).max(11),
  name: NON_EMPTY,
  isBodyPalace: z.boolean(),
  isOriginalPalace: z.boolean(),
  heavenlyStem: NON_EMPTY,
  earthlyBranch: NON_EMPTY,
  majorStars: z.array(ZiweiStarSchema),
  minorStars: z.array(ZiweiStarSchema),
  changsheng12: NON_EMPTY,
  decadal: z.object({
    startAge: z.number().int().min(0),
    endAge: z.number().int().min(0),
    heavenlyStem: NON_EMPTY,
    earthlyBranch: NON_EMPTY
  }).strict(),
  ages: z.array(z.number().int().min(0))
}).strict();

const ZiweiHoroscopeItemSchema = z.object({
  index: z.number().int(),
  name: NON_EMPTY,
  heavenlyStem: NON_EMPTY,
  earthlyBranch: NON_EMPTY,
  palaceNames: z.array(NON_EMPTY).length(12),
  transformations: z.array(NON_EMPTY).length(4),
  starsByPalace: z.array(z.array(ZiweiStarSchema)).length(12)
}).strict();

const ZiweiYearlyFortuneSchema = z.object({
  targetYear: z.number().int(),
  targetDate: SOLAR_DATE,
  solarDate: ENGINE_SOLAR_DATE,
  lunarDate: NON_EMPTY,
  decadal: ZiweiHoroscopeItemSchema,
  yearly: ZiweiHoroscopeItemSchema
}).strict();

export const ZiweiChartAuditSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  rulesetVersion: NON_EMPTY,
  candidateId: NON_EMPTY,
  engine: EngineIdentityAuditSchema,
  configuration: z.object({
    algorithm: NON_EMPTY,
    yearDivide: NON_EMPTY,
    horoscopeDivide: NON_EMPTY,
    ageDivide: NON_EMPTY,
    dayDivide: DAY_BOUNDARY,
    mutagens: NON_EMPTY,
    brightness: NON_EMPTY,
    astroType: NON_EMPTY,
    fixLeap: z.boolean(),
    language: NON_EMPTY,
    sourceTimeIndex: z.number().int().min(0).max(12),
    timeIndex: z.number().int().min(0).max(12)
  }).strict(),
  input: z.object({
    sourceLocalDateTime: LOCAL_DATE_TIME,
    calculationLocalDateTime: LOCAL_DATE_TIME,
    timeBasis: CANDIDATE_BASIS,
    sourceZiSegment: z.enum(["early", "late"]).nullable(),
    sourceDayBoundary: DAY_BOUNDARY,
    engineInputDate: SOLAR_DATE
  }).strict(),
  gender: z.enum(["男", "女"]),
  solarDate: SOLAR_DATE,
  lunarDate: NON_EMPTY,
  chineseDate: NON_EMPTY,
  time: NON_EMPTY,
  timeRange: NON_EMPTY,
  soulPalaceBranch: NON_EMPTY,
  bodyPalaceBranch: NON_EMPTY,
  soul: NON_EMPTY,
  body: NON_EMPTY,
  fiveElementsClass: NON_EMPTY,
  palaces: z.array(ZiweiPalaceSchema).length(12),
  transformations: z.array(z.object({
    palaceIndex: z.number().int().min(0).max(11),
    palaceName: NON_EMPTY,
    starName: NON_EMPTY,
    transformation: NON_EMPTY
  }).strict()).length(4),
  yearlyFortunes: z.array(ZiweiYearlyFortuneSchema)
}).strict().superRefine((chart, context) => {
  const palaceIndices = new Set(chart.palaces.map((palace) => palace.index));
  if (palaceIndices.size !== 12) {
    context.addIssue({
      code: "custom",
      message: "ZIWEI_PALACE_INDICES_INCOMPLETE",
      path: ["palaces"]
    });
  }
});

export const TrackFailureV1Schema = z.object({
  status: z.literal("error"),
  errorCode: NON_EMPTY,
  message: NON_EMPTY
}).strict();

export const AuditableChartBundleV1Schema = z.object({
  candidateId: NON_EMPTY,
  basis: CANDIDATE_BASIS.optional(),
  dayBoundary: DAY_BOUNDARY.optional(),
  calendarResolutionId: NON_EMPTY.optional(),
  calendarBasis: CALENDAR_BASIS.optional(),
  bazi: z.union([BaziChartAuditSchema, TrackFailureV1Schema]),
  ziwei: z.union([ZiweiChartAuditSchema, TrackFailureV1Schema]),
  complete: z.boolean().optional()
}).strict();

export const DualTrackChartSetAuditSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  caseId: NON_EMPTY,
  timeRulesetVersion: NON_EMPTY,
  engineVersions: z.object({
    bazi: EngineIdentityAuditSchema,
    ziwei: EngineIdentityAuditSchema
  }).strict(),
  chartRulesetVersions: z.object({
    bazi: NON_EMPTY,
    ziwei: NON_EMPTY
  }).strict(),
  targetYears: z.array(z.number().int()),
  candidates: z.array(AuditableChartBundleV1Schema).min(1)
}).strict();

export type BaziChartAudit = z.infer<typeof BaziChartAuditSchema>;
export type ZiweiChartAudit = z.infer<typeof ZiweiChartAuditSchema>;
export type TrackFailureV1 = z.infer<typeof TrackFailureV1Schema>;
export type AuditableChartBundleV1 = z.infer<typeof AuditableChartBundleV1Schema>;
export type DualTrackChartSetAudit = z.infer<typeof DualTrackChartSetAuditSchema>;

export function isTrackFailure(value: BaziChartAudit | ZiweiChartAudit | TrackFailureV1): value is TrackFailureV1 {
  return "status" in value && value.status === "error";
}
