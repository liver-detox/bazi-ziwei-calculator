import { describe, expect, it } from "vitest";

import { normalizeProvidedTime } from "../src/core/time/normalize-provided-time.js";
import { syntheticDemoRequest } from "./helpers/synthetic-demo-cases.js";

describe("synthetic public demo cases", () => {
  it("keeps every demo free of private and location fields", () => {
    for (const [label, caseId] of [
      ["DEMO-NORMAL", "CS-2000-901"],
      ["DEMO-LATE-ZI", "CS-2001-901"],
      ["DEMO-YEARS", "CS-2002-901"]
    ] as const) {
      const request = syntheticDemoRequest(label, caseId);
      expect(JSON.stringify(request)).not.toMatch(/privateName|birthplace|longitude|latitude|timeZone/u);
    }
  });

  it("produces one ordinary candidate and two late-Zi candidates", () => {
    const ordinary = syntheticDemoRequest("DEMO-NORMAL", "CS-2000-901");
    const lateZi = syntheticDemoRequest("DEMO-LATE-ZI", "CS-2001-901");
    expect(normalizeProvidedTime(ordinary.birthRecord).candidates).toHaveLength(1);
    expect(normalizeProvidedTime(lateZi.birthRecord).candidates).toHaveLength(2);
  });

  it("stores exactly the two shared target years", () => {
    expect(syntheticDemoRequest("DEMO-YEARS", "CS-2002-901").targetYears).toEqual([2026, 2030]);
  });
});
