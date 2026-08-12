import type { BirthRecordV1, TimeEvidenceV1 } from "../../shared/contracts.js";
import type {
  BirthRecordV2,
  TimeEvidenceV2
} from "../../shared/provided-time-contracts.js";

export interface ChartCalculationOptions {
  targetYears?: readonly number[];
  yearRange?: {
    startYear: number;
    endYear: number;
  };
  daYunCount?: number;
}

export type ChartBirthRecord = Pick<BirthRecordV1 | BirthRecordV2, "caseId" | "gender">;
export type ChartTimeCandidate = TimeEvidenceV1["candidates"][number] | TimeEvidenceV2["candidates"][number];
export type TimeCandidateV1 = ChartTimeCandidate;

export interface EngineIdentity {
  name: "lunar-typescript" | "iztro";
  version: "1.8.6" | "2.5.8";
}

export interface BaziPillar {
  ganZhi: string;
  heavenlyStem: string;
  earthlyBranch: string;
  hiddenStems: string[];
  stemTenGod: string;
  hiddenStemTenGods: string[];
  naYin: string;
  xun: string;
  voidBranches: string;
  growthStage: string;
}

export interface BaziAnnualFortune {
  year: number;
  age: number;
  ganZhi: string;
  xun: string;
  voidBranches: string;
  daYunIndex: number;
}

export interface BaziDaYun {
  index: number;
  startAge: number;
  endAge: number;
  startYear: number;
  endYear: number;
  ganZhi: string | null;
  xun: string | null;
  voidBranches: string | null;
}

export interface BaziChartV1 {
  schemaVersion: "1.0.0";
  rulesetVersion: "CyberSaga-Bazi-v1";
  candidateId: string;
  engine: EngineIdentity;
  configuration: {
    pillarSect: 1 | 2;
    luckSect: 1;
    yearBoundary: "li_chun";
    monthBoundary: "solar_terms";
    sourceDayBoundary: TimeCandidateV1["dayBoundary"];
  };
  input: {
    sourceLocalDateTime: string;
    calculationLocalDateTime: string;
    timeBasis: TimeCandidateV1["basis"];
    earthlyBranchIndex: number;
  };
  calendar: {
    solarDate: string;
    solarDateTime: string;
    lunarYear: number;
    lunarMonth: number;
    lunarDay: number;
    isLeapMonth: boolean;
    lunarText: string;
  };
  fourPillars: [string, string, string, string];
  pillars: {
    year: BaziPillar;
    month: BaziPillar;
    day: BaziPillar;
    time: BaziPillar;
  };
  luck: {
    genderCode: 0 | 1;
    forward: boolean;
    startSolarDateTime: string;
    startAfter: { years: number; months: number; days: number; hours: number };
    daYun: BaziDaYun[];
  };
  annualFortunes: BaziAnnualFortune[];
}

export interface NormalizedZiweiStar {
  name: string;
  type: string;
  scope: string;
  brightness: string | null;
  transformation: string | null;
}

export interface ZiweiPalace {
  index: number;
  name: string;
  isBodyPalace: boolean;
  isOriginalPalace: boolean;
  heavenlyStem: string;
  earthlyBranch: string;
  majorStars: NormalizedZiweiStar[];
  minorStars: NormalizedZiweiStar[];
  changsheng12: string;
  decadal: {
    startAge: number;
    endAge: number;
    heavenlyStem: string;
    earthlyBranch: string;
  };
  ages: number[];
}

export interface ZiweiHoroscopeItem {
  index: number;
  name: string;
  heavenlyStem: string;
  earthlyBranch: string;
  palaceNames: string[];
  transformations: string[];
  starsByPalace: NormalizedZiweiStar[][];
}

export interface ZiweiYearlyFortune {
  targetYear: number;
  targetDate: string;
  solarDate: string;
  lunarDate: string;
  decadal: ZiweiHoroscopeItem;
  yearly: ZiweiHoroscopeItem;
}

export interface ZiweiChartV1 {
  schemaVersion: "1.0.0";
  rulesetVersion: "CyberSaga-Ziwei-v1";
  candidateId: string;
  engine: EngineIdentity;
  configuration: {
    algorithm: "default";
    yearDivide: "normal";
    horoscopeDivide: "normal";
    ageDivide: "normal";
    dayDivide: "current" | "forward";
    mutagens: "iztro-2.5.8-default";
    brightness: "iztro-2.5.8-default";
    astroType: "heaven";
    fixLeap: true;
    language: "zh-CN";
    sourceTimeIndex: number;
    timeIndex: number;
  };
  input: {
    sourceLocalDateTime: string;
    calculationLocalDateTime: string;
    timeBasis: TimeCandidateV1["basis"];
    sourceZiSegment: TimeCandidateV1["ziSegment"];
    sourceDayBoundary: TimeCandidateV1["dayBoundary"];
    engineInputDate: string;
  };
  gender: ChartBirthRecord["gender"];
  solarDate: string;
  lunarDate: string;
  chineseDate: string;
  time: string;
  timeRange: string;
  soulPalaceBranch: string;
  bodyPalaceBranch: string;
  soul: string;
  body: string;
  fiveElementsClass: string;
  palaces: ZiweiPalace[];
  transformations: Array<{
    palaceIndex: number;
    palaceName: string;
    starName: string;
    transformation: string;
  }>;
  yearlyFortunes: ZiweiYearlyFortune[];
}

export interface CandidateDualChartV1 {
  candidateId: string;
  basis: TimeCandidateV1["basis"];
  dayBoundary: TimeCandidateV1["dayBoundary"];
  calendarResolutionId?: TimeCandidateV1["calendarResolutionId"];
  calendarBasis?: TimeCandidateV1["calendarBasis"];
  bazi: BaziChartV1;
  ziwei: ZiweiChartV1;
}

export interface DualTrackChartSetV1 {
  schemaVersion: "1.0.0";
  caseId: ChartBirthRecord["caseId"];
  timeRulesetVersion: TimeEvidenceV1["rulesetVersion"] | TimeEvidenceV2["rulesetVersion"];
  engineVersions: {
    bazi: EngineIdentity;
    ziwei: EngineIdentity;
  };
  chartRulesetVersions: {
    bazi: "CyberSaga-Bazi-v1";
    ziwei: "CyberSaga-Ziwei-v1";
  };
  targetYears: number[];
  candidates: CandidateDualChartV1[];
}
