import { describe, expect, it } from "vitest";
import { Lunar } from "lunar-typescript";
import { astro } from "iztro";

import { calculateCandidateCharts } from "../src/core/charts/index.js";
import { resolveSharedSupportedTargetYears } from "../src/core/charts/bazi-detail.js";
import { filterZiweiSupportedTargetYears } from "../src/core/charts/ziwei.js";
import { normalizeProvidedTime } from "../src/core/time/normalize-provided-time.js";
import { buildProvidedTimeRequest } from "../src/web/provided-time-form-model.js";
import { SYNTHETIC_DEMO_FORMS, syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";
import { SPRING_FESTIVAL_DATES_1900_2099 } from "../src/shared/spring-festival-dates.generated.js";
import { ziweiDecadalYearBoundary, ziweiDecadalBoundaryText } from "../src/shared/ziwei-decadal-boundary.js";

const TARGET_YEARS_1900_TO_2099 = Array.from({ length: 200 }, (_, index) => 1900 + index);

const BOUNDARY_CASES = [
  ["1900-01-30 male", "CS-1900-001", "1900-01-30", "12:00", "男", 1],
  ["1900-01-31 female", "CS-1900-002", "1900-01-31", "12:00", "女", 1],
  ["2099-01-20 female", "CS-2099-001", "2099-01-20", "12:00", "女", 1],
  ["2099-12-30 late-zi male", "CS-2099-002", "2099-12-30", "23:30", "男", 2]
] as const;

function boundaryRequest(
  alias: string,
  caseId: string,
  date: string,
  localTime: string,
  gender: "男" | "女"
) {
  return buildProvidedTimeRequest(
    {
      ...SYNTHETIC_DEMO_FORMS["DEMO-NORMAL"],
      alias,
      date,
      localTime,
      gender
    },
    { caseId }
  );
}

describe("Zi Wei supported-year snapshot equivalence", () => {
  it("keeps the bounded Spring Festival table identical to the locked calendar dependency", () => {
    expect(SPRING_FESTIVAL_DATES_1900_2099).toEqual(Array.from({ length: 200 }, (_, index) => Lunar.fromYmd(1900 + index, 1, 1).getSolar().toYmd()));
  });

  it.each([
    ["2000-03-04", "12:34", "男", 2011, ["changed"]],
    ["2000-03-04", "12:34", "男", 2010, ["unchanged"]],
    ["2000-03-04", "12:34", "男", 2001, ["changed"]],
    ["2000-01-15", "12:00", "女", 2013, ["changed"]],
    ["2000-01-15", "12:00", "女", 2001, ["changed"]],
    ["2000-02-04", "23:30", "男", 2014, ["unchanged", "changed"]]
  ] as const)("matches actual eve/day decadal membership for %s %s %s in %i with only that target year", (date, localTime, gender, year, statuses) => {
    const record = boundaryRequest("SYNTHETIC-SPRING-SWITCH", "CS-2000-992", date, localTime, gender).birthRecord;
    const evidence = normalizeProvidedTime(record);
    const charts = calculateCandidateCharts(record, evidence, { targetYears: [year] });
    const previousConfig = structuredClone(astro.getConfig());
    try {
      const boundaries = charts.candidates.map(({ ziwei }) => {
        const boundary = ziweiDecadalYearBoundary(ziwei, year);
        expect(["changed", "unchanged"]).toContain(boundary.status);
        if (boundary.status !== "changed" && boundary.status !== "unchanged") throw new Error("Expected usable synthetic boundary");
        const engine = astro.withOptions({
          type: "solar", dateStr: ziwei.input.engineInputDate, timeIndex: ziwei.configuration.timeIndex,
          gender, fixLeap: true, language: "zh-CN", astroType: "heaven",
          config: { algorithm: "default", yearDivide: "normal", horoscopeDivide: "normal", ageDivide: "normal", dayDivide: "current" }
        });
        for (const [targetDate, assignment] of [[boundary.eve, boundary.before], [boundary.date, boundary.after]] as const) {
          const actual = engine.horoscope(targetDate, ziwei.configuration.timeIndex).decadal;
          expect(assignment.palaceIndex).toBe(actual.index);
          expect(assignment.ganZhi).toBe(`${actual.heavenlyStem}${actual.earthlyBranch}`);
          expect(assignment.kind === "childhood" ? "童限" : "大限").toBe(actual.name);
          expect(assignment.natalPalace).toBe(ziwei.palaces[actual.index].name);
        }
        expect(ziwei.yearlyFortunes).toHaveLength(1);
        if (date === "2000-01-15" && year === 2001) {
          expect(ziweiDecadalBoundaryText(boundary).join("\n")).toContain("童限换宫日期（不属十年大限交接）");
        }
        if (date === "2000-03-04" && year === 2001) {
          expect(ziweiDecadalBoundaryText(boundary).join("\n")).toContain("童限转大限日期");
        }
        return boundary;
      });
      expect(boundaries.map(({ status }) => status)).toEqual(statuses);
      if (localTime === "23:30") {
        expect(charts.candidates.map(({ ziwei }) => ziwei.input.engineInputDate)).toEqual(["2000-02-04", "2000-02-05"]);
      }
    } finally {
      astro.config({
        algorithm: previousConfig.algorithm, yearDivide: previousConfig.yearDivide,
        horoscopeDivide: previousConfig.horoscopeDivide, ageDivide: previousConfig.ageDivide,
        dayDivide: previousConfig.dayDivide
      });
    }
  });

  it("continues to reject corrupted pre-luck and nonzero annual periods", () => {
    const publicBirthRecord = boundaryRequest("SYNTHETIC-EMPTY-PERIOD", "CS-2000-972", "2000-03-04", "12:34", "男").birthRecord;
    const timeEvidence = normalizeProvidedTime(publicBirthRecord);
    const baseChartSet = calculateCandidateCharts(publicBirthRecord, timeEvidence, { targetYears: [] });
    for (const [index, endYear] of [[0, 1998], [1, 1999]]) {
      const corrupted = structuredClone(baseChartSet);
      corrupted.candidates[0].bazi.luck.daYun[index].endYear = endYear;
      expect(() => resolveSharedSupportedTargetYears({ publicBirthRecord, timeEvidence, baseChartSet: corrupted })).toThrow();
    }
  });

  it.each([
    ["DEMO-NORMAL", "CS-2000-940", 1],
    ["DEMO-LATE-ZI", "CS-2001-941", 2]
  ] as const)("matches the engine path for every %s candidate from 1900 through 2099", (
    label,
    caseId,
    expectedCandidateCount
  ) => {
    const record = syntheticDemoRequest(label, caseId).birthRecord;
    const evidence = normalizeProvidedTime(record);
    const natalCharts = calculateCandidateCharts(record, evidence, { targetYears: [] });

    expect(evidence.candidates).toHaveLength(expectedCandidateCount);
    for (const candidate of evidence.candidates) {
      const natal = natalCharts.candidates.find(({ candidateId }) => candidateId === candidate.id);
      expect(natal, `${label}/${candidate.id} must have its own natal snapshot`).toBeDefined();
      if (natal === undefined) continue;

      const enginePath = filterZiweiSupportedTargetYears(
        record,
        candidate,
        TARGET_YEARS_1900_TO_2099
      );
      const snapshotPath = filterZiweiSupportedTargetYears(
        record,
        candidate,
        TARGET_YEARS_1900_TO_2099,
        natal.ziwei
      );

      expect(snapshotPath, `${label}/${candidate.id}`).toEqual(enginePath);
    }
  }, 20_000);

  it.each(BOUNDARY_CASES)(
    "matches the engine path for every %s candidate from 1900 through 2099",
    (label, caseId, date, localTime, gender, expectedCandidateCount) => {
      const record = boundaryRequest(label, caseId, date, localTime, gender).birthRecord;
      const evidence = normalizeProvidedTime(record);
      const natalCharts = calculateCandidateCharts(record, evidence, { targetYears: [] });

      expect(evidence.candidates).toHaveLength(expectedCandidateCount);
      for (const candidate of evidence.candidates) {
        const natal = natalCharts.candidates.find(({ candidateId }) => candidateId === candidate.id);
        expect(natal, `${label}/${candidate.id} must have its own natal snapshot`).toBeDefined();
        if (natal === undefined) continue;

        const enginePath = filterZiweiSupportedTargetYears(
          record,
          candidate,
          TARGET_YEARS_1900_TO_2099
        );
        const snapshotPath = filterZiweiSupportedTargetYears(
          record,
          candidate,
          TARGET_YEARS_1900_TO_2099,
          natal.ziwei
        );

        expect(snapshotPath, `${label}/${candidate.id}`).toEqual(enginePath);
      }
    },
    20_000
  );
});
