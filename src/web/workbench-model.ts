import {
  clockConventionValidationIssues,
  explicitClockConventionProfile,
  locationRequiresClockConventionConfirmation,
  type ClockConventionLocationEvidenceV1
} from "../shared/clock-convention.js";
import type { BirthRecordV1 } from "../shared/contracts.js";
import { UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1 } from "../shared/unknown-birthplace.js";

export {
  buildProvidedTimeRequest,
  emptyProvidedTimeForm,
  nextAvailableCaseId,
  parseTargetYearsInput,
  shouldShowLateZiChoice,
  shouldShowLeapMonthChoice
} from "./provided-time-form-model.js";
export type { ProvidedTimeFormState } from "./provided-time-form-model.js";

/** @deprecated Compatibility for the legacy App shell; Task 8 removes its final production use. */
export const WORKFLOW_STEPS = [
  { id: "record", label: "资料录入" },
  { id: "time", label: "时间核验" },
  { id: "charts", label: "双轨排盘" },
  { id: "audit", label: "差异复核" },
  { id: "export", label: "导出证据" }
] as const;

export type WorkflowStepId = typeof WORKFLOW_STEPS[number]["id"];

export function shouldOpenSidebar(viewportWidth: number): boolean {
  return viewportWidth > 820;
}

export interface BirthFormState {
  caseId: string;
  alias: string;
  privateName: string;
  gender: "男" | "女";
  calendarType: "solar" | "lunar";
  date: string;
  leapMonth: boolean | "unknown";
  localTime: string;
  precision: "minute" | "approximate" | "branch";
  sourceType: "birth_certificate" | "hospital_record" | "family_memory" | "existing_chart" | "unknown";
  sourceNote: string;
  locationLabel: string;
  countryCode: string;
  latitude: string;
  longitude: string;
  timeZone: string;
  clockConvention: "official" | "beijing" | "xinjiang" | "unknown";
  coordinateSource: "representative_city" | "representative_with_longitude_override" | "manual" | "documented_exact" | "unknown";
  geoNamesId: string;
  representativeLongitude: string;
  requiresClockConventionConfirmation: boolean;
  standardOffsetMinutes: string;
  unknownBirthplaceConfirmed: boolean;
  legacySourcePath: string;
  legacySourceSha256: string;
  targetYears: string;
  trueSolar: "compare" | "civil_only" | "apparent_primary";
  dst: "iana" | "standard_time" | "unknown";
  lateZi: "candidates" | "current_day" | "next_day";
}

export interface LocationSelectionForForm {
  geonameId: number;
  nameZh: string;
  latitude: number;
  longitude: number;
  timeZoneSuggestions: readonly string[];
  requiresClockConventionConfirmation: boolean;
}

export function applyLocationSelectionToForm(
  form: BirthFormState,
  city: LocationSelectionForForm
): BirthFormState {
  const defaultTimeZone = city.timeZoneSuggestions[0];
  if (defaultTimeZone === undefined) {
    throw new Error("地点快照缺少 IANA 时区建议");
  }
  const requiresClockConventionConfirmation = locationRequiresClockConventionConfirmation({
    countryCode: "CN",
    latitude: city.latitude,
    longitude: city.longitude,
    timeZone: defaultTimeZone,
    geoNamesReference: {
      geonameId: city.geonameId,
      snapshotVersion: "GeoNames-CN-major-cities-v1",
      contentSha256: "bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d",
      coordinateKind: "representative"
    }
  });
  return {
    ...form,
    countryCode: "CN",
    locationLabel: `${city.nameZh}（代表点）`,
    latitude: String(city.latitude),
    longitude: String(city.longitude),
    timeZone: defaultTimeZone,
    clockConvention: requiresClockConventionConfirmation ? "unknown" : "official",
    coordinateSource: "representative_city",
    geoNamesId: String(city.geonameId),
    representativeLongitude: String(city.longitude),
    requiresClockConventionConfirmation,
    standardOffsetMinutes: "",
    unknownBirthplaceConfirmed: false
  };
}

export function applyUnknownBirthplaceBasisToForm(form: BirthFormState): BirthFormState {
  const basis = UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1;
  return {
    ...form,
    locationLabel: basis.label,
    countryCode: basis.countryCode,
    latitude: "",
    longitude: String(basis.longitude),
    timeZone: basis.timeZone,
    standardOffsetMinutes: String(basis.standardOffsetMinutes),
    clockConvention: basis.clockConvention,
    coordinateSource: basis.coordinateSource,
    geoNamesId: "",
    representativeLongitude: "",
    requiresClockConventionConfirmation: false,
    trueSolar: basis.trueSolar,
    dst: basis.dst,
    unknownBirthplaceConfirmed: true
  };
}

export function applyClockConventionToForm(
  form: BirthFormState,
  clockConvention: BirthFormState["clockConvention"]
): BirthFormState {
  const profile = explicitClockConventionProfile(clockConvention);
  if (profile === undefined) {
    const next = { ...form, clockConvention, unknownBirthplaceConfirmed: false };
    return {
      ...next,
      requiresClockConventionConfirmation: formRequiresClockConventionConfirmation(next)
    };
  }
  const next = {
    ...form,
    clockConvention,
    unknownBirthplaceConfirmed: false,
    timeZone: profile.timeZone,
    standardOffsetMinutes: String(profile.standardOffsetMinutes)
  };
  return {
    ...next,
    requiresClockConventionConfirmation: formRequiresClockConventionConfirmation(next)
  };
}

function formLocationEvidence(form: BirthFormState): ClockConventionLocationEvidenceV1 {
  const latitude = form.latitude.trim() === "" ? undefined : Number(form.latitude);
  const longitude = form.longitude.trim() === "" ? undefined : Number(form.longitude);
  const standardOffsetMinutes = form.standardOffsetMinutes.trim() === ""
    ? undefined
    : Number(form.standardOffsetMinutes);
  return {
    countryCode: form.countryCode.trim().toUpperCase(),
    ...(latitude === undefined ? {} : { latitude }),
    ...(longitude === undefined ? {} : { longitude }),
    timeZone: form.timeZone.trim(),
    ...(standardOffsetMinutes === undefined ? {} : { standardOffsetMinutes }),
    clockConvention: form.clockConvention,
    ...((form.coordinateSource === "representative_city" || form.coordinateSource === "representative_with_longitude_override") && form.geoNamesId !== "" ? {
      geoNamesReference: {
        geonameId: Number(form.geoNamesId),
        snapshotVersion: "GeoNames-CN-major-cities-v1",
        contentSha256: "bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d",
        coordinateKind: "representative"
      }
    } : {})
  };
}

export function formRequiresClockConventionConfirmation(form: BirthFormState): boolean {
  return locationRequiresClockConventionConfirmation(formLocationEvidence(form));
}

const PALACE_POSITIONS = [
  { row: 4, column: 4 },
  { row: 4, column: 3 },
  { row: 4, column: 2 },
  { row: 4, column: 1 },
  { row: 3, column: 1 },
  { row: 2, column: 1 },
  { row: 1, column: 1 },
  { row: 1, column: 2 },
  { row: 1, column: 3 },
  { row: 1, column: 4 },
  { row: 2, column: 4 },
  { row: 3, column: 4 }
] as const;

export function getPalaceGridPosition(index: number): { row: number; column: number } {
  if (!Number.isInteger(index) || index < 0 || index > 11) {
    throw new RangeError("宫位序号必须是 0–11");
  }
  return PALACE_POSITIONS[index];
}

export function workflowStatusLabel(status: string): string {
  return ({
    draft: "草稿",
    review: "待复核",
    verified: "已核验",
    void: "已作废"
  } as Record<string, string>)[status] ?? status;
}

export function buildBirthRecordFromForm(form: BirthFormState): BirthRecordV1 {
  const latitude = form.latitude.trim() === "" ? undefined : Number(form.latitude);
  const longitude = Number(form.longitude);
  const standardOffsetMinutes = form.standardOffsetMinutes.trim() === ""
    ? undefined
    : Number(form.standardOffsetMinutes);
  if ((latitude !== undefined && !Number.isFinite(latitude)) || !Number.isFinite(longitude)) {
    throw new Error("经纬度必须是有效数字");
  }
  if (standardOffsetMinutes !== undefined && !Number.isInteger(standardOffsetMinutes)) {
    throw new Error("标准偏移必须是整数分钟");
  }
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
    throw new Error("纬度必须在 -90 至 90 之间");
  }
  if (longitude < -180 || longitude > 180) {
    throw new Error("经度必须在 -180 至 180 之间");
  }
  if (standardOffsetMinutes !== undefined && (standardOffsetMinutes < -840 || standardOffsetMinutes > 840)) {
    throw new Error("标准偏移必须在 -840 至 840 分钟之间");
  }
  if (
    form.coordinateSource === "representative_with_longitude_override"
    && (form.representativeLongitude.trim() === "" || !Number.isFinite(Number(form.representativeLongitude)))
  ) {
    throw new Error("经度覆盖缺少代表点原经度");
  }

  const location = {
    label: form.locationLabel.trim(),
    countryCode: form.countryCode.trim().toUpperCase(),
    ...(latitude === undefined ? {} : { latitude }),
    longitude,
    timeZone: form.timeZone.trim(),
    ...(standardOffsetMinutes === undefined ? {} : { standardOffsetMinutes }),
    clockConvention: form.clockConvention,
    coordinateSource: form.coordinateSource,
    ...((form.coordinateSource === "representative_city" || form.coordinateSource === "representative_with_longitude_override") && form.geoNamesId !== "" ? {
      geoNamesReference: {
        geonameId: Number(form.geoNamesId),
        snapshotVersion: "GeoNames-CN-major-cities-v1" as const,
        contentSha256: "bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d" as const,
        coordinateKind: "representative" as const
      }
    } : {}),
    ...(form.coordinateSource === "representative_with_longitude_override" ? {
      longitudeOverride: {
        representativeLongitude: Number(form.representativeLongitude),
        reason: "operator_override" as const
      }
    } : {}),
    requiresClockConventionConfirmation: formRequiresClockConventionConfirmation(form)
  };
  const clockIssues = clockConventionValidationIssues(location);
  if (clockIssues[0] !== undefined) {
    throw new Error(clockIssues[0].message);
  }

  return {
    schemaVersion: "1.0.0",
    caseId: form.caseId.trim(),
    alias: form.alias.trim(),
    ...(form.privateName.trim() === "" ? {} : { privateName: form.privateName.trim() }),
    gender: form.gender,
    calendar: {
      type: form.calendarType,
      date: form.date,
      leapMonth: form.calendarType === "lunar" && form.leapMonth
    },
    birthTime: {
      localTime: form.localTime,
      precision: form.precision,
      sourceType: form.sourceType,
      ...(form.sourceNote.trim() === "" ? {} : { sourceNote: form.sourceNote.trim() })
    },
    location,
    policy: {
      trueSolar: form.trueSolar,
      dst: form.dst,
      lateZi: form.lateZi
    }
  } as BirthRecordV1;
}
