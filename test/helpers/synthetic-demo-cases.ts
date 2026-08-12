import {
  buildProvidedTimeRequest,
  type ProvidedTimeFormState,
  type ProvidedTimeRequest
} from "../../src/web/provided-time-form-model.js";

export const SYNTHETIC_DEMO_FORMS = Object.freeze({
  "DEMO-NORMAL": Object.freeze({
    alias: "DEMO-NORMAL", privateName: "", gender: "女", calendarType: "solar",
    date: "2000-01-15", leapMonth: false, localTime: "12:00",
    timeBasis: "civil_clock_provided", precision: "minute", sourceType: "unknown",
    sourceNote: "", birthplaceNote: "", lateZi: "candidates", targetYears: ""
  }),
  "DEMO-LATE-ZI": Object.freeze({
    alias: "DEMO-LATE-ZI", privateName: "", gender: "男", calendarType: "solar",
    date: "2001-07-15", leapMonth: false, localTime: "23:30",
    timeBasis: "civil_clock_provided", precision: "minute", sourceType: "unknown",
    sourceNote: "", birthplaceNote: "", lateZi: "candidates", targetYears: ""
  }),
  "DEMO-YEARS": Object.freeze({
    alias: "DEMO-YEARS", privateName: "", gender: "女", calendarType: "solar",
    date: "2002-08-16", leapMonth: false, localTime: "08:08",
    timeBasis: "civil_clock_provided", precision: "minute", sourceType: "unknown",
    sourceNote: "", birthplaceNote: "", lateZi: "candidates", targetYears: "2026, 2030"
  })
} satisfies Record<string, ProvidedTimeFormState>);

export function syntheticDemoRequest(
  label: keyof typeof SYNTHETIC_DEMO_FORMS,
  caseId: string
): ProvidedTimeRequest {
  return buildProvidedTimeRequest(SYNTHETIC_DEMO_FORMS[label], { caseId });
}
