export const BAZI_DETAIL_RULE_V1 = Object.freeze({
  rulesetVersion: "CyberSaga-Bazi-Detail-v1", engine: "lunar-typescript@1.8.6", annualBoundary: "li_chun", monthBoundary: "solar_terms", monthInterval: "half_open", solarTermTimeBasis: "lunar_typescript_get_jie_qi_table", calculationPrecision: "second", primaryDisplayPrecision: "minute_truncate", maxTargetYears: 50, maxDaYunPeriods: 20, liuYuePerYear: 12
} as const);
export const AUDIT_RULE_V2 = Object.freeze({
  rulesetVersion: "CyberSaga-Audit-v2", contentFingerprintScope: "provided-time-charts-bazi-detail-rules-manual-v1", requiredRuleKeys: Object.freeze(["providedTime", "bazi", "baziDetail", "ziwei", "audit"]), requiredDependencyKeys: Object.freeze(["lunar", "ziwei", "canonicalization"])
} as const);
export const BAZI_DETAIL_RULE_V1_SHA256 = "15d153ba7ad94cae8b285663c54356183a1e769a85b1d94c8e9f6c388939927a" as const;
export const AUDIT_RULE_V2_SHA256 = "076f378ca277e910026e215b353a8275278c1c822872881ceeaa8bcef2373138" as const;
