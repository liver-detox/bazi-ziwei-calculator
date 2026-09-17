import { describe, expect, it } from "vitest";
import { Solar } from "lunar-typescript";

import reference from "./fixtures/independent-chart-rules.json";
import { calculateBaziChart, withLockedLunarLanguage } from "../src/core/charts/bazi.js";
import { calculateZiweiChart } from "../src/core/charts/ziwei.js";
import { normalizeProvidedTime } from "../src/core/time/normalize-provided-time.js";
import { PublicBirthRecordV2Schema } from "../src/shared/provided-time-contracts.js";

const stems = "甲乙丙丁戊己庚辛壬癸";
const transformations = ["禄", "权", "科", "忌"];

function expectedTransformations(stem: string): string[] {
  // Keep the original frozen Ren/Tianfu row intact. The named modern source
  // supports the explicitly selected Ren/Zuofu variant after comparison.
  if (stem === "壬") return reference.fourTransformationsModernRen;
  return reference.fourTransformationsClassical[
    stem as keyof typeof reference.fourTransformationsClassical
  ];
}

function recordFor(id: string, gender: string, date: string, time: string, lunar = false, leap = false) {
  return PublicBirthRecordV2Schema.parse({
    schemaVersion: "2.0.0",
    caseId: `CS-2024-${id.replace(/\D/gu, "").padStart(3, "0")}`,
    alias: `SYNTHETIC-${id}`,
    gender,
    calendar: { type: lunar ? "lunar" : "solar", date, leapMonth: leap },
    providedTime: {
      localTime: time, basis: "civil_clock_provided", precision: "minute", sourceType: "unknown"
    },
    policy: { lateZi: "current_day" }
  });
}

describe("independent HKO solar terms and classical qi-yun reference", () => {
  for (const term of reference.solarTerms) {
    it(`matches HKO UTC+08 minute term ${term.localDateTime} ${term.name}`, () => {
      const year = Number(term.localDateTime.slice(0, 4));
      const actual = withLockedLunarLanguage(() =>
        Solar.fromYmd(year, 7, 1).getLunar().getJieQiTable()[term.name].toYmdHms());
      const difference = Math.abs(Date.parse(actual.replace(" ", "T") + "+08:00")
        - Date.parse(term.localDateTime + "+08:00"));
      // HKO publishes minute precision. This is not a second-accuracy claim.
      expect(difference).toBeLessThanOrEqual(60_000);
    });
  }

  for (const sample of reference.qiYun) {
    it(`matches frozen independent qi-yun arithmetic ${sample.id}`, () => {
      const record = recordFor(sample.id, sample.gender,
        sample.birthLocalDateTime.slice(0, 10), sample.birthLocalDateTime.slice(11, 16));
      const candidate = normalizeProvidedTime(record).candidates[0];
      const chart = calculateBaziChart(record, candidate, { targetYears: [] });
      expect(chart.pillars.year.heavenlyStem).toBe(sample.yearStem);
      expect(chart.luck.forward).toBe(sample.expected.forward);
      expect(chart.luck.startAfter).toEqual(sample.expected.startAfter);
      expect(chart.luck.startSolarDateTime).toBe(sample.expected.startSolarDateTime);
    });
  }
});

describe("independent normalized-lunar Ziwei reference with explicit source variants", () => {
  for (const sample of reference.ziwei) {
    it(`matches independently frozen palaces, stars, and decade ranges ${sample.input.id}`, () => {
      const input = sample.input;
      const expected = sample.expected;
      // Calendar conversion is transport into the adapter, not independent
      // validation of conversion: the reference starts at this lunar date.
      const year = input.is_leap_month ? 2023 : 2004 + stems.indexOf(input.year_stem);
      const date = `${year}-${String(input.lunar_month).padStart(2, "0")}-${String(input.lunar_day).padStart(2, "0")}`;
      const time = "civil_time_label" in input && input.civil_time_label
        ? input.civil_time_label : `${String(input.time_index * 2).padStart(2, "0")}:00`;
      const record = recordFor(input.id, input.sex, date, time, true, input.is_leap_month);
      const candidate = normalizeProvidedTime(record).candidates[0];
      const chart = calculateZiweiChart(record, candidate,
        { targetYears: Array.from({ length: 10 }, (_, index) => 2024 + index) });
      expect(chart.soulPalaceBranch).toBe(expected.ming_branch);
      expect(chart.bodyPalaceBranch).toBe(expected.shen_branch);
      expect(chart.fiveElementsClass).toBe(`${expected.five_element}${["", "", "二", "三", "四", "五", "六"][expected.bureau]}局`);
      for (const palace of expected.palaces) {
        expect(chart.palaces.find(item => item.earthlyBranch === palace.branch)?.heavenlyStem)
          .toBe(palace.stem);
      }
      const stars = { ...expected.major_stars, ...expected.auxiliary_stars_fortel };
      for (const [name, branch] of Object.entries(stars)) {
        expect(chart.palaces.filter(palace => [...palace.majorStars, ...palace.minorStars]
          .some(star => star.name === name)).map(palace => palace.earthlyBranch)).toEqual([branch]);
      }
      for (const decade of expected.decade_fortel.first_four) {
        const palace = chart.palaces.find(item => item.earthlyBranch === decade.branch)!;
        expect([palace.decadal.startAge, palace.decadal.endAge])
          .toEqual([decade.age_start, decade.age_end]);
      }
      const natal = expectedTransformations(input.year_stem);
      transformations.forEach((hua, index) => {
        const actual = chart.transformations.filter(item => item.transformation === hua);
        expect(actual).toHaveLength(1);
        expect(actual[0].starName).toBe(natal[index]);
        expect(chart.palaces[actual[0].palaceIndex].earthlyBranch)
          .toBe(stars[natal[index] as keyof typeof stars]);
      });
      // The same independently sourced ten-stem table applies to each
      // supplied decade/year stem; this does not certify the annual boundary.
      for (const fortune of chart.yearlyFortunes) {
        for (const layer of [fortune.decadal, fortune.yearly]) {
          expect(layer.transformations).toEqual(expectedTransformations(layer.heavenlyStem));
        }
      }
    });
  }

  for (const sample of reference.ziwei.filter(item => ["Z19", "Z20"].includes(item.input.id))) {
    it(`maps an explicitly selected forward late-Zi day to the frozen lunar date ${sample.input.id}`, () => {
      const input = sample.input;
      const record = recordFor(input.id, input.sex, "2004-04-21",
        "civil_time_label" in input ? input.civil_time_label! : "23:00", true);
      record.policy.lateZi = "next_day";
      const candidate = normalizeProvidedTime(record).candidates[0];
      expect(candidate.dayBoundary).toBe("forward");
      const chart = calculateZiweiChart(record, candidate, { targetYears: [] });
      expect(chart.soulPalaceBranch).toBe(sample.expected.ming_branch);
      expect(chart.bodyPalaceBranch).toBe(sample.expected.shen_branch);
      for (const [star, branch] of Object.entries(sample.expected.major_stars)) {
        expect(chart.palaces.find(palace => palace.majorStars.some(item => item.name === star))?.earthlyBranch)
          .toBe(branch);
      }
    });
  }
});
