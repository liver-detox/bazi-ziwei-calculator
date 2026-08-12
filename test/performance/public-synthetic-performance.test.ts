import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { calculateCandidateCharts } from "../../src/core/charts/index.js";
import { normalizeProvidedTime } from "../../src/core/time/normalize-provided-time.js";
import {
  SYNTHETIC_DEMO_FORMS,
  syntheticDemoRequest
} from "../helpers/synthetic-demo-cases.js";

const benchmarkCases = [
  { label: "DEMO-NORMAL", caseId: "CS-2000-901", candidateCount: 1, targetYears: [] },
  { label: "DEMO-LATE-ZI", caseId: "CS-2001-901", candidateCount: 2, targetYears: [] },
  { label: "DEMO-YEARS", caseId: "CS-2002-901", candidateCount: 1, targetYears: [2026, 2030] }
] as const;

describe("public synthetic performance", () => {
  it("calculates the three frozen demos within two seconds", () => {
    expect(Object.keys(SYNTHETIC_DEMO_FORMS)).toEqual(benchmarkCases.map(({ label }) => label));

    const startedAt = performance.now();
    const results = benchmarkCases.map(({ label, caseId }) => {
      const request = syntheticDemoRequest(label, caseId);
      const evidence = normalizeProvidedTime(request.birthRecord);
      return calculateCandidateCharts(request.birthRecord, evidence, {
        targetYears: request.targetYears
      });
    });
    const elapsedMs = performance.now() - startedAt;

    expect(results.map(({ candidates }) => candidates.length))
      .toEqual(benchmarkCases.map(({ candidateCount }) => candidateCount));
    expect(results.map(({ targetYears }) => targetYears))
      .toEqual(benchmarkCases.map(({ targetYears }) => [...targetYears]));
    console.info(`PUBLIC_SYNTHETIC_PERFORMANCE cases=${results.length} elapsedMs=${elapsedMs.toFixed(3)}`);
    expect(elapsedMs, `three public synthetic charts took ${elapsedMs.toFixed(3)}ms`)
      .toBeLessThan(2_000);
  });
});
