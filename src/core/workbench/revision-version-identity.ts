import {
  AUDIT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION_V1,
  AUDIT_CONTRACT_VERSION_V2,
  AUDIT_CONTRACT_VERSION_V3,
  AUDIT_CONTRACT_VERSION_V4,
  AUDIT_EXPECTED_VERSION_EVIDENCE,
  AUDIT_EXPECTED_VERSION_EVIDENCE_V2,
  AUDIT_EXPECTED_VERSION_EVIDENCE_V3,
  AuditReportV1Schema,
  AuditReportV2Schema,
  VersionEvidenceV1Schema,
  VersionEvidenceV2Schema,
  VersionEvidenceV3Schema,
  assessAuditVersionEvidence,
  assessAuditVersionEvidenceV3,
  compareUnicodeCodePoints,
  isV4ProvidedTimeAuditBoundaryConsistent,
  type AuditReportV1,
  type AuditReportV2,
  type VersionEvidenceV1,
  type VersionEvidenceV2,
  type VersionEvidenceV3
} from "../audit/index.js";
import { GEONAMES_CN_MANIFEST } from "../location/geonames-snapshot.js";
import {
  RULESET_SNAPSHOT_MANIFEST,
  XINJIANG_LOCATION_RULE_EVIDENCE
} from "../rules/ruleset-manifest.js";
import { UNKNOWN_BIRTHPLACE_RULE_EVIDENCE } from "../rules/unknown-birthplace-manifest.js";

export {
  AUDIT_CONTRACT_VERSION,
  AUDIT_CONTRACT_VERSION_V1,
  AUDIT_CONTRACT_VERSION_V2,
  AUDIT_CONTRACT_VERSION_V3,
  AUDIT_CONTRACT_VERSION_V4
} from "../audit/index.js";

export interface HistoricalRuleIdentityV1 {
  snapshot: string;
  time: string;
  bazi: string;
  ziwei: string;
  audit: string;
  xinjiangLocation: string;
}

export interface CurrentRuleIdentityV2 extends HistoricalRuleIdentityV1 {
  unknownBirthplace: string;
}

export interface ProvidedTimeRuleIdentityV3 {
  providedTime: string;
  bazi: string;
  ziwei: string;
  audit: string;
}

export interface ProvidedTimeRuleIdentityV4 {
  providedTime: string;
  bazi: "CyberSaga-Bazi-v1";
  baziDetail: "CyberSaga-Bazi-Detail-v1";
  ziwei: "CyberSaga-Ziwei-v1";
  audit: "CyberSaga-Audit-v2";
}

export type ApprovedRuleIdentity = HistoricalRuleIdentityV1 | CurrentRuleIdentityV2 | ProvidedTimeRuleIdentityV3 | ProvidedTimeRuleIdentityV4;

export interface CurrentDependencyIdentityV1 {
  lunar: string;
  ziwei: string;
  timezone: string;
  canonicalization: string;
  location: string;
}

export interface ProvidedTimeDependencyIdentityV3 {
  lunar: string;
  ziwei: string;
  canonicalization: string;
}

export interface ProvidedTimeDependencyIdentityV4 {
  lunar: "lunar-typescript@1.8.6";
  ziwei: "iztro@2.5.8";
  canonicalization: "json-canonicalize@2.0.0";
}

export type ApprovedDependencyIdentity = CurrentDependencyIdentityV1 | ProvidedTimeDependencyIdentityV3 | ProvidedTimeDependencyIdentityV4;

export type RevisionGenerationV1 = "modern" | "old_modern" | "legacy";

export interface RevisionIdentityMismatchV1 {
  path: "auditContractVersion" | `rules.${string}` | `dependencies.${string}`;
  kind: "missing" | "unexpected" | "value_mismatch";
  expected: string | null;
  actual: string | null;
}

export type RevisionIdentityAssessmentV1 =
  | {
      generation: "modern" | "old_modern";
      trust: "approved";
      expectedRules: ApprovedRuleIdentity;
      expectedDependencies: ApprovedDependencyIdentity;
    }
  | {
      generation: "modern" | "old_modern";
      trust: "invalid";
      mismatches: RevisionIdentityMismatchV1[];
    }
  | {
      generation: "legacy";
      trust: "unvalidated";
    };

function projectHistoricalIdentity(input: {
  evidence: VersionEvidenceV1;
  auditRuleset: string;
  canonicalization: string;
}): {
  rules: HistoricalRuleIdentityV1;
  dependencies: CurrentDependencyIdentityV1;
} {
  const { evidence } = input;
  const xinjiang = evidence.xinjiangLocationRule;
  if (xinjiang === undefined) {
    throw new TypeError("approved Xinjiang rule evidence is required");
  }
  return {
    rules: {
      snapshot: `${RULESET_SNAPSHOT_MANIFEST.snapshotVersion}#sha256:${RULESET_SNAPSHOT_MANIFEST.contentSha256}`,
      time: evidence.timeRuleset,
      bazi: evidence.baziRuleset,
      ziwei: evidence.ziweiRuleset,
      audit: input.auditRuleset,
      xinjiangLocation: `${xinjiang.ruleId}@${xinjiang.rulesetVersion}#sha256:${xinjiang.contentSha256}`
    },
    dependencies: {
      lunar: `${evidence.lunarEngine.name}@${evidence.lunarEngine.version}`,
      ziwei: `${evidence.ziweiEngine.name}@${evidence.ziweiEngine.version}`,
      timezone: `${evidence.timezoneEngine.corePackage}@${evidence.timezoneEngine.coreVersion}+${evidence.timezoneEngine.timezonePackage}@${evidence.timezoneEngine.timezoneVersion}#tzdb-${evidence.timezoneEngine.tzdbVersion}`,
      canonicalization: input.canonicalization,
      location: `${GEONAMES_CN_MANIFEST.snapshotVersion}#sha256:${GEONAMES_CN_MANIFEST.contentSha256}`
    }
  };
}

function projectCurrentIdentity(input: {
  evidence: VersionEvidenceV1;
  auditRuleset: string;
  canonicalization: string;
}): {
  rules: CurrentRuleIdentityV2;
  dependencies: CurrentDependencyIdentityV1;
} {
  const historical = projectHistoricalIdentity(input);
  const unknownBirthplace = input.evidence.unknownBirthplaceRule;
  if (unknownBirthplace === undefined) {
    throw new TypeError("approved unknown birthplace rule evidence is required");
  }
  return {
    rules: {
      ...historical.rules,
      unknownBirthplace: `${unknownBirthplace.ruleId}@${unknownBirthplace.rulesetVersion}#sha256:${unknownBirthplace.contentSha256}`
    },
    dependencies: historical.dependencies
  };
}

function projectProvidedTimeIdentity(input: {
  evidence: VersionEvidenceV2;
  auditRuleset: string;
  canonicalization: string;
}): {
  rules: ProvidedTimeRuleIdentityV3;
  dependencies: ProvidedTimeDependencyIdentityV3;
} {
  return {
    rules: {
      providedTime: `${input.evidence.providedTimeRule.ruleId}@${input.evidence.providedTimeRule.rulesetVersion}#sha256:${input.evidence.providedTimeRule.contentSha256}`,
      bazi: input.evidence.baziRuleset,
      ziwei: input.evidence.ziweiRuleset,
      audit: input.auditRuleset
    },
    dependencies: {
      lunar: `${input.evidence.lunarEngine.name}@${input.evidence.lunarEngine.version}`,
      ziwei: `${input.evidence.ziweiEngine.name}@${input.evidence.ziweiEngine.version}`,
      canonicalization: input.canonicalization
    }
  };
}

function projectDetailedProvidedTimeIdentity(input: {
  evidence: VersionEvidenceV3;
  canonicalization: "json-canonicalize@2.0.0";
}): {
  rules: ProvidedTimeRuleIdentityV4;
  dependencies: ProvidedTimeDependencyIdentityV4;
} {
  return {
    rules: {
      providedTime: `${input.evidence.providedTimeRule.ruleId}@${input.evidence.providedTimeRule.rulesetVersion}#sha256:${input.evidence.providedTimeRule.contentSha256}`,
      bazi: input.evidence.baziRuleset,
      baziDetail: input.evidence.baziDetailRuleset,
      ziwei: input.evidence.ziweiRuleset,
      audit: input.evidence.auditRuleset
    },
    dependencies: {
      lunar: `${input.evidence.lunarEngine.name}@${input.evidence.lunarEngine.version}`,
      ziwei: `${input.evidence.ziweiEngine.name}@${input.evidence.ziweiEngine.version}`,
      canonicalization: input.canonicalization
    }
  };
}

function freezeIdentity(identity: {
  rules: CurrentRuleIdentityV2;
  dependencies: CurrentDependencyIdentityV1;
}): Readonly<{
  rules: CurrentRuleIdentityV2;
  dependencies: CurrentDependencyIdentityV1;
}> {
  return Object.freeze({
    rules: Object.freeze(identity.rules),
    dependencies: Object.freeze(identity.dependencies)
  });
}

function freezeProvidedTimeIdentity(identity: {
  rules: ProvidedTimeRuleIdentityV3;
  dependencies: ProvidedTimeDependencyIdentityV3;
}): Readonly<{
  rules: ProvidedTimeRuleIdentityV3;
  dependencies: ProvidedTimeDependencyIdentityV3;
}> {
  return Object.freeze({
    rules: Object.freeze(identity.rules),
    dependencies: Object.freeze(identity.dependencies)
  });
}

function freezeDetailedProvidedTimeIdentity(identity: {
  rules: ProvidedTimeRuleIdentityV4;
  dependencies: ProvidedTimeDependencyIdentityV4;
}): Readonly<{
  rules: ProvidedTimeRuleIdentityV4;
  dependencies: ProvidedTimeDependencyIdentityV4;
}> {
  return Object.freeze({
    rules: Object.freeze(identity.rules),
    dependencies: Object.freeze(identity.dependencies)
  });
}

const approvedEvidence = VersionEvidenceV1Schema.parse(AUDIT_EXPECTED_VERSION_EVIDENCE);

export const CURRENT_APPROVED_REVISION_IDENTITY = freezeIdentity(projectCurrentIdentity({
  evidence: approvedEvidence,
  auditRuleset: AUDIT_EXPECTED_VERSION_EVIDENCE.auditRuleset,
  canonicalization: "json-canonicalize@2.0.0"
}));

const providedTimeEvidence = VersionEvidenceV2Schema.parse({
  ...AUDIT_EXPECTED_VERSION_EVIDENCE_V2,
  timeInputBasis: "apparent_solar_provided"
});

export const PROVIDED_TIME_APPROVED_REVISION_IDENTITY_V3 = freezeProvidedTimeIdentity(projectProvidedTimeIdentity({
  evidence: providedTimeEvidence,
  auditRuleset: AUDIT_EXPECTED_VERSION_EVIDENCE_V2.auditRuleset,
  canonicalization: "json-canonicalize@2.0.0"
}));

const detailedProvidedTimeEvidence = VersionEvidenceV3Schema.parse({
  ...AUDIT_EXPECTED_VERSION_EVIDENCE_V3,
  timeInputBasis: "apparent_solar_provided"
});

export const PROVIDED_TIME_APPROVED_REVISION_IDENTITY_V4 = freezeDetailedProvidedTimeIdentity(
  projectDetailedProvidedTimeIdentity({
    evidence: detailedProvidedTimeEvidence,
    canonicalization: "json-canonicalize@2.0.0"
  })
);

function providedTimeReportBoundaryIsValid(
  report: AuditReportV1,
  evidence: VersionEvidenceV2
): boolean {
  const boundary = report.timeInputBoundary;
  const expectedCode = evidence.timeInputBasis === "apparent_solar_provided"
    ? "provided_apparent_solar"
    : "provided_civil_clock";
  const expectedBasisFlag = evidence.timeInputBasis === "apparent_solar_provided"
    ? "provided_time_apparent_solar"
    : "provided_time_civil_clock";
  const flags = report.provenanceFlags;
  const allowedFlags = flags !== undefined
    && new Set(flags).size === flags.length
    && flags.includes(expectedBasisFlag)
    && !flags.includes(expectedBasisFlag === "provided_time_apparent_solar"
      ? "provided_time_civil_clock"
      : "provided_time_apparent_solar")
    && flags.every((flag) => flag === expectedBasisFlag || flag === "provided_time_source_note_present");
  return boundary !== undefined
    && boundary.basis === evidence.timeInputBasis
    && boundary.assertionCode === expectedCode
    && report.contentFingerprint.scope === "provided-time-charts-rules-manual-v1"
    && allowedFlags;
}

function detailedProvidedTimeReportBoundaryIsValid(
  report: AuditReportV2,
  evidence: VersionEvidenceV3
): boolean {
  return isV4ProvidedTimeAuditBoundaryConsistent({
    engineVersions: evidence,
    timeInputBoundary: report.timeInputBoundary,
    provenanceFlags: report.provenanceFlags
  })
    && report.contentFingerprint.scope === "provided-time-charts-bazi-detail-rules-manual-v1";
}

export function deriveApprovedRevisionIdentity(
  report: AuditReportV1 | AuditReportV2,
  auditContractVersion:
    | typeof AUDIT_CONTRACT_VERSION_V1
    | typeof AUDIT_CONTRACT_VERSION_V2
    | typeof AUDIT_CONTRACT_VERSION_V3
    | typeof AUDIT_CONTRACT_VERSION_V4 = AUDIT_CONTRACT_VERSION_V2
): {
  rules: ApprovedRuleIdentity;
  dependencies: ApprovedDependencyIdentity;
} {
  if (auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
    const parsedV4 = AuditReportV2Schema.safeParse(report);
    if (!parsedV4.success || !assessAuditVersionEvidenceV3(parsedV4.data.engineVersions).approved) {
      throw new TypeError("approved AuditReportV2 is required");
    }
    const evidence = VersionEvidenceV3Schema.parse(parsedV4.data.engineVersions);
    if (!detailedProvidedTimeReportBoundaryIsValid(parsedV4.data, evidence)) {
      throw new TypeError("detailed provided-time audit boundary is inconsistent");
    }
    return projectDetailedProvidedTimeIdentity({
      evidence,
      canonicalization: parsedV4.data.contentFingerprint.canonicalization
    });
  }
  const parsed = AuditReportV1Schema.safeParse(report);
  if (!parsed.success) {
    throw new TypeError("approved AuditReportV1 is required");
  }
  if (!assessAuditVersionEvidence(parsed.data.engineVersions).approved) {
    throw new TypeError("approved audit version evidence is required");
  }
  if (auditContractVersion === AUDIT_CONTRACT_VERSION_V3) {
    const evidence = VersionEvidenceV2Schema.parse(parsed.data.engineVersions);
    if (
      !providedTimeReportBoundaryIsValid(parsed.data, evidence)
      || parsed.data.rulesetVersion !== evidence.auditRuleset
    ) {
      throw new TypeError("provided-time audit boundary is inconsistent");
    }
    return projectProvidedTimeIdentity({
      evidence,
      auditRuleset: parsed.data.rulesetVersion,
      canonicalization: parsed.data.contentFingerprint.canonicalization
    });
  }
  if (
    parsed.data.timeInputBoundary !== undefined
    || parsed.data.provenanceFlags !== undefined
    || parsed.data.contentFingerprint.scope !== "birth-time-charts-rules-manual-v1"
    || VersionEvidenceV2Schema.safeParse(parsed.data.engineVersions).success
  ) {
    throw new TypeError("historical audit contract cannot contain provided-time evidence");
  }
  const evidence = VersionEvidenceV1Schema.parse(parsed.data.engineVersions);
  if (parsed.data.rulesetVersion !== evidence.auditRuleset) {
    throw new TypeError("audit ruleset identity is inconsistent");
  }
  if (auditContractVersion === AUDIT_CONTRACT_VERSION_V1) {
    if (evidence.unknownBirthplaceRule !== undefined) {
      throw new TypeError("v1 audit contract cannot contain unknown-birthplace rule evidence");
    }
    return projectHistoricalIdentity({
      evidence,
      auditRuleset: parsed.data.rulesetVersion,
      canonicalization: parsed.data.contentFingerprint.canonicalization
    });
  }
  if (evidence.unknownBirthplaceRule === undefined) {
    throw new TypeError("approved current unknown birthplace rule evidence is required");
  }
  return projectCurrentIdentity({
    evidence,
    auditRuleset: parsed.data.rulesetVersion,
    canonicalization: parsed.data.contentFingerprint.canonicalization
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareTable(
  table: "rules" | "dependencies",
  actual: Record<string, string>,
  expected: object
): RevisionIdentityMismatchV1[] {
  const expectedValues = new Map(Object.entries(expected));
  const keys = new Set([...Object.keys(actual), ...expectedValues.keys()]);
  return [...keys].flatMap((key): RevisionIdentityMismatchV1[] => {
    const hasActual = Object.prototype.hasOwnProperty.call(actual, key);
    const hasExpected = expectedValues.has(key);
    const path = `${table}.${key}` as RevisionIdentityMismatchV1["path"];
    if (!hasActual) {
      return [{ path, kind: "missing", expected: stringValue(expectedValues.get(key)), actual: null }];
    }
    if (!hasExpected) {
      return [{ path, kind: "unexpected", expected: null, actual: stringValue(actual[key]) }];
    }
    const expectedValue = stringValue(expectedValues.get(key));
    if (actual[key] !== expectedValue) {
      return [{
        path,
        kind: "value_mismatch",
        expected: expectedValue,
        actual: stringValue(actual[key])
      }];
    }
    return [];
  });
}

function sortMismatches(mismatches: RevisionIdentityMismatchV1[]): RevisionIdentityMismatchV1[] {
  return mismatches.sort((left, right) => (
    compareUnicodeCodePoints(left.path, right.path)
    || compareUnicodeCodePoints(left.kind, right.kind)
  ));
}

export function assessStoredRevisionIdentity(input: {
  auditContractVersion?: string;
  manifestRules: Record<string, string>;
  manifestDependencies: Record<string, string>;
  report: unknown;
}): RevisionIdentityAssessmentV1 {
  const hasMarker = Object.prototype.hasOwnProperty.call(input, "auditContractVersion");
  const hasXinjiang = Object.prototype.hasOwnProperty.call(input.manifestRules, "xinjiangLocation");
  const generation: RevisionGenerationV1 = hasMarker ? "modern" : hasXinjiang ? "old_modern" : "legacy";
  if (generation === "legacy") {
    return { generation, trust: "unvalidated" };
  }

  if (
    generation === "modern"
    && input.auditContractVersion !== AUDIT_CONTRACT_VERSION_V4
    && input.auditContractVersion !== AUDIT_CONTRACT_VERSION_V3
    && input.auditContractVersion !== AUDIT_CONTRACT_VERSION_V2
    && input.auditContractVersion !== AUDIT_CONTRACT_VERSION_V1
  ) {
    return {
      generation,
      trust: "invalid",
      mismatches: [{
        path: "auditContractVersion",
        kind: "value_mismatch",
        expected: AUDIT_CONTRACT_VERSION,
        actual: stringValue(input.auditContractVersion)
      }]
    };
  }

  if (generation === "modern" && input.auditContractVersion === AUDIT_CONTRACT_VERSION_V4) {
    const parsedV4 = AuditReportV2Schema.safeParse(input.report);
    if (!parsedV4.success || !assessAuditVersionEvidenceV3(parsedV4.data.engineVersions).approved) {
      return { generation, trust: "invalid", mismatches: [] };
    }
    const evidence = parsedV4.data.engineVersions;
    if (!detailedProvidedTimeReportBoundaryIsValid(parsedV4.data, evidence)) {
      return { generation, trust: "invalid", mismatches: [] };
    }
    const expected = projectDetailedProvidedTimeIdentity({
      evidence,
      canonicalization: parsedV4.data.contentFingerprint.canonicalization
    });
    const mismatches = [
      ...compareTable("rules", input.manifestRules, expected.rules),
      ...compareTable("dependencies", input.manifestDependencies, expected.dependencies)
    ];
    if (mismatches.length > 0) {
      return { generation, trust: "invalid", mismatches: sortMismatches(mismatches) };
    }
    return {
      generation,
      trust: "approved",
      expectedRules: expected.rules,
      expectedDependencies: expected.dependencies
    };
  }

  const parsedReport = AuditReportV1Schema.safeParse(input.report);
  if (!parsedReport.success || !assessAuditVersionEvidence(parsedReport.data.engineVersions).approved) {
    return { generation, trust: "invalid", mismatches: [] };
  }
  if (generation === "modern" && input.auditContractVersion === AUDIT_CONTRACT_VERSION_V3) {
    let expected: ReturnType<typeof projectProvidedTimeIdentity>;
    try {
      const evidence = VersionEvidenceV2Schema.parse(parsedReport.data.engineVersions);
      if (
        !providedTimeReportBoundaryIsValid(parsedReport.data, evidence)
        || parsedReport.data.rulesetVersion !== evidence.auditRuleset
      ) return { generation, trust: "invalid", mismatches: [] };
      expected = projectProvidedTimeIdentity({
        evidence,
        auditRuleset: parsedReport.data.rulesetVersion,
        canonicalization: parsedReport.data.contentFingerprint.canonicalization
      });
    } catch {
      return { generation, trust: "invalid", mismatches: [] };
    }
    const mismatches = [
      ...compareTable("rules", input.manifestRules, expected.rules),
      ...compareTable("dependencies", input.manifestDependencies, expected.dependencies)
    ];
    if (mismatches.length > 0) {
      return { generation, trust: "invalid", mismatches: sortMismatches(mismatches) };
    }
    return {
      generation,
      trust: "approved",
      expectedRules: expected.rules,
      expectedDependencies: expected.dependencies
    };
  }
  if (
    parsedReport.data.timeInputBoundary !== undefined
    || parsedReport.data.provenanceFlags !== undefined
    || parsedReport.data.contentFingerprint.scope !== "birth-time-charts-rules-manual-v1"
    || VersionEvidenceV2Schema.safeParse(parsedReport.data.engineVersions).success
  ) {
    return { generation, trust: "invalid", mismatches: [] };
  }
  const evidence = VersionEvidenceV1Schema.parse(parsedReport.data.engineVersions);
  if (parsedReport.data.rulesetVersion !== evidence.auditRuleset) {
    return { generation, trust: "invalid", mismatches: [] };
  }
  const currentMarker = generation === "modern" && input.auditContractVersion === AUDIT_CONTRACT_VERSION_V2;
  const unknownEvidence = evidence.unknownBirthplaceRule;
  const unknownEvidenceMatches = unknownEvidence !== undefined
    && unknownEvidence.ruleId === UNKNOWN_BIRTHPLACE_RULE_EVIDENCE.ruleId
    && unknownEvidence.rulesetVersion === UNKNOWN_BIRTHPLACE_RULE_EVIDENCE.rulesetVersion
    && unknownEvidence.contentSha256 === UNKNOWN_BIRTHPLACE_RULE_EVIDENCE.contentSha256;
  if ((currentMarker && !unknownEvidenceMatches) || (!currentMarker && unknownEvidence !== undefined)) {
    return { generation, trust: "invalid", mismatches: [] };
  }
  const projectionInput = {
    evidence,
    auditRuleset: parsedReport.data.rulesetVersion,
    canonicalization: parsedReport.data.contentFingerprint.canonicalization
  };
  const expected = currentMarker
    ? projectCurrentIdentity(projectionInput)
    : projectHistoricalIdentity(projectionInput);

  const mismatches = [
    ...compareTable("rules", input.manifestRules, expected.rules),
    ...compareTable("dependencies", input.manifestDependencies, expected.dependencies)
  ];

  if (mismatches.length > 0) {
    return { generation, trust: "invalid", mismatches: sortMismatches(mismatches) };
  }
  return {
    generation,
    trust: "approved",
    expectedRules: expected.rules,
    expectedDependencies: expected.dependencies
  };
}
