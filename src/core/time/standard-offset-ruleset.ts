export interface StandardOffsetRuleV1 {
  readonly ruleId: string;
  readonly timeZone: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly standardOffsetMinutes: number;
  readonly source: string;
}

export const STANDARD_OFFSET_RULESET_VERSION = "CyberSaga-StandardOffset-v1" as const;

export const STANDARD_OFFSET_RULES_V1: readonly StandardOffsetRuleV1[] = [
  {
    ruleId: "asia-shanghai-1901-2099",
    timeZone: "Asia/Shanghai",
    validFrom: "1901-01-01",
    validTo: "2099-12-31",
    standardOffsetMinutes: 480,
    source: "IANA tzdb 2026a and audited V1 fixtures"
  },
  {
    ruleId: "america-new-york-1900-2099",
    timeZone: "America/New_York",
    validFrom: "1900-01-01",
    validTo: "2099-12-31",
    standardOffsetMinutes: -300,
    source: "IANA tzdb 2026a and audited V1 fixtures"
  }
] as const;

export function findStandardOffsetRule(
  timeZone: string,
  solarDate: string
): StandardOffsetRuleV1 | undefined {
  return STANDARD_OFFSET_RULES_V1.find((rule) => (
    rule.timeZone === timeZone
    && solarDate >= rule.validFrom
    && solarDate <= rule.validTo
  ));
}
