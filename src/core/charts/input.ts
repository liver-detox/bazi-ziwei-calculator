import { LocalDateTime } from "@js-joda/core";

import type { ChartCalculationOptions, ChartTimeCandidate } from "./types.js";

export function resolveTargetYears(
  calculationYear: number,
  options: ChartCalculationOptions
): number[] {
  const explicitlyProvided = options.targetYears !== undefined;
  const years = new Set<number>(options.targetYears ?? []);
  if (options.yearRange !== undefined) {
    const { startYear, endYear } = options.yearRange;
    if (
      !Number.isInteger(startYear)
      || !Number.isInteger(endYear)
      || startYear > endYear
      || startYear < 1900
      || endYear > 2099
    ) {
      throw new Error("yearRange 必须是有效且递增的整数年份范围");
    }
    for (let year = startYear; year <= endYear; year += 1) {
      years.add(year);
    }
  }
  if (!explicitlyProvided && options.yearRange === undefined) {
    years.add(calculationYear);
  }
  const sorted = [...years].sort((left, right) => left - right);
  if (sorted.some((year) => !Number.isInteger(year) || year < 1900 || year > 2099)) {
    throw new Error("流年范围必须位于 1900–2099");
  }
  return sorted;
}

export function resolveEngineLocalDateTime(candidate: ChartTimeCandidate): LocalDateTime {
  const calculation = LocalDateTime.parse(candidate.localDateTime);
  return candidate.ziSegment === "late" && candidate.dayBoundary === "forward"
    ? calculation.minusDays(1)
    : calculation;
}

export function toMinuteLocalDateTime(localDateTime: LocalDateTime): string {
  return localDateTime.withSecond(0).withNano(0).toString();
}
