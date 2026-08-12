import { z } from "zod";

const SHA256 = z.string().regex(/^[a-f0-9]{64}$/u);

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN").replace(/\s+/gu, "");
}

export const GeoNamesAdminPlaceV2Schema = z.object({
  geonameId: z.number().int().positive(),
  nameZh: z.string().trim().min(1),
  fullNameZh: z.string().trim().min(1),
  nameLatin: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)),
  admin1Zh: z.string().trim().min(1),
  admin2Zh: z.string().trim().min(1),
  placeType: z.enum(["prefecture", "district", "county", "county_level_city", "other_county_level"]),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  timeZoneSuggestions: z.array(z.string().trim().min(1)).min(1),
  requiresClockConventionConfirmation: z.boolean(),
  coordinateKind: z.literal("representative")
}).strict().superRefine((place, context) => {
  if (new Set(place.aliases).size !== place.aliases.length) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "aliases 必须唯一" });
  }
  const sortedAliases = [...place.aliases].sort(compareUnicodeCodePoints);
  if (place.aliases.some((alias, index) => alias !== sortedAliases[index])) {
    context.addIssue({ code: "custom", path: ["aliases"], message: "aliases 必须按 Unicode code point 排序" });
  }
  if (new Set(place.timeZoneSuggestions).size !== place.timeZoneSuggestions.length) {
    context.addIssue({ code: "custom", path: ["timeZoneSuggestions"], message: "IANA 时区建议必须唯一" });
  }
});

export const GeoNamesAdminPlaceSnapshotV2Schema = z.object({
  schemaVersion: z.literal("2.0.0"),
  snapshotVersion: z.literal("GeoNames-CN-admin-places-v2"),
  countryCode: z.literal("CN"),
  places: z.array(GeoNamesAdminPlaceV2Schema).min(1).max(10_000)
}).strict().superRefine((snapshot, context) => {
  const ids = new Set<number>();
  const fullNames = new Set<string>();
  for (const [index, place] of snapshot.places.entries()) {
    if (ids.has(place.geonameId)) {
      context.addIssue({ code: "custom", path: ["places", index, "geonameId"], message: "geonameId 必须唯一" });
    }
    ids.add(place.geonameId);
    const identity = normalizedIdentity(place.fullNameZh);
    if (fullNames.has(identity)) {
      context.addIssue({ code: "custom", path: ["places", index, "fullNameZh"], message: "规范 fullNameZh 必须唯一" });
    }
    fullNames.add(identity);
    if (index > 0) {
      const previous = snapshot.places[index - 1];
      const order = compareUnicodeCodePoints(previous.fullNameZh, place.fullNameZh)
        || previous.geonameId - place.geonameId;
      if (order > 0) {
        context.addIssue({ code: "custom", path: ["places", index], message: "places 必须稳定排序" });
      }
    }
  }
});

export const GeoNamesAdminSnapshotIdentityV2Schema = z.object({
  snapshotVersion: z.literal("GeoNames-CN-admin-places-v2"),
  snapshotSha256: SHA256
}).strict();

export const AdminPlaceSearchResponseV2Schema = z.object({
  items: z.array(GeoNamesAdminPlaceV2Schema).max(20),
  totalMatches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  snapshotVersion: z.literal("GeoNames-CN-admin-places-v2"),
  snapshotSha256: SHA256
}).strict().superRefine((response, context) => {
  if (response.totalMatches < response.items.length) {
    context.addIssue({ code: "custom", path: ["totalMatches"], message: "totalMatches 不得小于 items 长度" });
  }
  if (response.truncated !== (response.totalMatches > response.items.length)) {
    context.addIssue({ code: "custom", path: ["truncated"], message: "truncated 与匹配数量不一致" });
  }
});

export type GeoNamesAdminPlaceV2 = z.infer<typeof GeoNamesAdminPlaceV2Schema>;
export type GeoNamesAdminPlaceSnapshotV2 = z.infer<typeof GeoNamesAdminPlaceSnapshotV2Schema>;
export type GeoNamesAdminSnapshotIdentityV2 = z.infer<typeof GeoNamesAdminSnapshotIdentityV2Schema>;
export type AdminPlaceSearchResponseV2 = z.infer<typeof AdminPlaceSearchResponseV2Schema>;
