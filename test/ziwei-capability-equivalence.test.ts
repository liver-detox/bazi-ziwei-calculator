import { describe, expect, it } from "vitest";

import { calculateCandidateCharts } from "../src/core/charts/index.js";
import { filterZiweiSupportedTargetYears } from "../src/core/charts/ziwei.js";
import { normalizeProvidedTime } from "../src/core/time/normalize-provided-time.js";
import { buildProvidedTimeRequest } from "../src/web/provided-time-form-model.js";
import { SYNTHETIC_DEMO_FORMS, syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";

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
