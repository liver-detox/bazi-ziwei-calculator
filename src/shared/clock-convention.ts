export const EXPLICIT_CLOCK_CONVENTIONS_V1 = Object.freeze({
  beijing: Object.freeze({ timeZone: "Asia/Shanghai", standardOffsetMinutes: 480 }),
  xinjiang: Object.freeze({ timeZone: "Asia/Urumqi", standardOffsetMinutes: 360 })
} as const);

export const XINJIANG_LOCATION_RULE_V1 = Object.freeze({
  ruleId: "xinjiang-clock-convention-confirmation",
  rulesetVersion: "CyberSaga-Xinjiang-Location-v1",
  countryCode: "CN",
  alwaysConfirmTimeZones: Object.freeze(["Asia/Urumqi"] as const),
  geoNamesSnapshotVersion: "GeoNames-CN-major-cities-v1",
  geoNamesSnapshotSha256: "bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d",
  geoNamesCoordinateKind: "representative",
  trustedGeoNameIds: Object.freeze([1529102] as const),
  conservativeBounds: Object.freeze({
    minLatitude: 34,
    maxLatitude: 49.5,
    minLongitude: 73,
    maxLongitude: 96.5
  }),
  longitudeOnlyWithinBoundsRequiresConfirmation: true
} as const);

export type ExplicitClockConventionV1 = keyof typeof EXPLICIT_CLOCK_CONVENTIONS_V1;

export interface ClockConventionLocationEvidenceV1 {
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  standardOffsetMinutes?: number;
  clockConvention?: string;
  geoNamesReference?: {
    geonameId?: number;
    snapshotVersion?: string;
    contentSha256?: string;
    coordinateKind?: string;
  };
}

export interface ClockConventionValidationIssueV1 {
  path: "timeZone" | "standardOffsetMinutes" | "clockConvention";
  message: string;
}

export function explicitClockConventionProfile(
  convention: string
): typeof EXPLICIT_CLOCK_CONVENTIONS_V1[ExplicitClockConventionV1] | undefined {
  return Object.hasOwn(EXPLICIT_CLOCK_CONVENTIONS_V1, convention)
    ? EXPLICIT_CLOCK_CONVENTIONS_V1[convention as ExplicitClockConventionV1]
    : undefined;
}

function isTrustedXinjiangGeoNamesReference(
  location: ClockConventionLocationEvidenceV1
): boolean {
  const reference = location.geoNamesReference;
  return location.countryCode === XINJIANG_LOCATION_RULE_V1.countryCode
    && reference?.snapshotVersion === XINJIANG_LOCATION_RULE_V1.geoNamesSnapshotVersion
    && reference.contentSha256 === XINJIANG_LOCATION_RULE_V1.geoNamesSnapshotSha256
    && reference.coordinateKind === XINJIANG_LOCATION_RULE_V1.geoNamesCoordinateKind
    && typeof reference.geonameId === "number"
    && XINJIANG_LOCATION_RULE_V1.trustedGeoNameIds.some((geonameId) => geonameId === reference.geonameId);
}

function isInsideConservativeXinjiangBounds(
  location: ClockConventionLocationEvidenceV1
): boolean {
  if (location.countryCode !== XINJIANG_LOCATION_RULE_V1.countryCode || !Number.isFinite(location.longitude)) return false;
  const longitude = location.longitude as number;
  const bounds = XINJIANG_LOCATION_RULE_V1.conservativeBounds;
  if (longitude < bounds.minLongitude || longitude > bounds.maxLongitude) return false;
  if (location.latitude === undefined) {
    // Many historical/manual records contain only longitude. The longitude-only
    // corridor intentionally prefers a false positive requiring human confirmation
    // over a silent Xinjiang clock conversion.
    return XINJIANG_LOCATION_RULE_V1.longitudeOnlyWithinBoundsRequiresConfirmation;
  }
  return Number.isFinite(location.latitude)
    && location.latitude >= bounds.minLatitude
    && location.latitude <= bounds.maxLatitude;
}

export function locationRequiresClockConventionConfirmation(
  location: ClockConventionLocationEvidenceV1
): boolean {
  return (typeof location.timeZone === "string"
      && XINJIANG_LOCATION_RULE_V1.alwaysConfirmTimeZones.some((timeZone) => timeZone === location.timeZone))
    || isTrustedXinjiangGeoNamesReference(location)
    || isInsideConservativeXinjiangBounds(location);
}

export function clockConventionValidationIssues(
  location: ClockConventionLocationEvidenceV1
): ClockConventionValidationIssueV1[] {
  const issues: ClockConventionValidationIssueV1[] = [];
  const convention = location.clockConvention ?? "";
  const profile = explicitClockConventionProfile(convention);
  if (profile !== undefined && location.timeZone !== profile.timeZone) {
    issues.push({
      path: "timeZone",
      message: `${convention} 钟表口径必须使用 ${profile.timeZone}`
    });
  }
  if (
    profile !== undefined
    && location.standardOffsetMinutes !== undefined
    && location.standardOffsetMinutes !== profile.standardOffsetMinutes
  ) {
    issues.push({
      path: "standardOffsetMinutes",
      message: `${convention} 钟表口径的标准偏移必须为 ${profile.standardOffsetMinutes} 分钟`
    });
  }
  if (
    locationRequiresClockConventionConfirmation(location)
    && convention !== "beijing"
    && convention !== "xinjiang"
  ) {
    issues.push({
      path: "clockConvention",
      message: "该地点必须明确选择北京时间或新疆时间"
    });
  }
  return issues;
}
