import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

export const PROVIDED_TIME_RULE_V1 = Object.freeze({
  ruleId: "provided-final-local-time",
  rulesetVersion: "CyberSaga-Provided-Time-v1",
  bases: Object.freeze(["apparent_solar_provided", "civil_clock_provided"]),
  noLocationConversion: true,
  noTimezoneConversion: true,
  noTrueSolarRecalculation: true,
  lateZiDefault: "parallel-current-and-forward",
  supportedYears: Object.freeze([1900, 2099])
} as const);

const canonicalRule = canonicalize(PROVIDED_TIME_RULE_V1);

export const PROVIDED_TIME_RULE_EVIDENCE = Object.freeze({
  ruleId: PROVIDED_TIME_RULE_V1.ruleId,
  rulesetVersion: PROVIDED_TIME_RULE_V1.rulesetVersion,
  contentSha256: createHash("sha256").update(canonicalRule, "utf8").digest("hex")
});
