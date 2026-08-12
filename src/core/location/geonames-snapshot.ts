import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const SNAPSHOT_URL = new URL("../../data/geonames-cn-major-cities.v1.json", import.meta.url);

export const GEONAMES_CN_MANIFEST = Object.freeze({
  snapshotVersion: "GeoNames-CN-major-cities-v1",
  countryCode: "CN",
  retrievedAt: "2026-08-06",
  sourceDataset: "GeoNames Gazetteer — licensed major-city excerpt",
  sourceUrl: "https://www.geonames.org/search.html?country=CN",
  sourceDumpUrl: "https://download.geonames.org/export/dump/CN.zip",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "Contains information from GeoNames (www.geonames.org), licensed under CC BY 4.0.",
  representativePointOnly: true,
  cityCount: 32,
  contentFile: "src/data/geonames-cn-major-cities.v1.json",
  contentSha256: "bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d"
} as const);

const GeoNamesCitySchema = z.object({
  geonameId: z.number().int().positive(),
  nameZh: z.string().min(1),
  nameLatin: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  admin1: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  timeZoneSuggestions: z.array(z.string().min(1)).min(1),
  requiresClockConventionConfirmation: z.boolean(),
  coordinateKind: z.literal("representative")
}).strict();

const GeoNamesChinaSnapshotSchema = z.object({
  snapshotVersion: z.literal("GeoNames-CN-major-cities-v1"),
  countryCode: z.literal("CN"),
  cities: z.array(GeoNamesCitySchema).length(GEONAMES_CN_MANIFEST.cityCount)
}).strict();

export type GeoNamesChinaCity = z.infer<typeof GeoNamesCitySchema>;
export type GeoNamesChinaSnapshot = z.infer<typeof GeoNamesChinaSnapshotSchema>;

let snapshotPromise: Promise<GeoNamesChinaSnapshot> | undefined;

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s'’._-]+/gu, "");
}

async function readVerifiedSnapshot(): Promise<GeoNamesChinaSnapshot> {
  const bytes = await readFile(SNAPSHOT_URL);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== GEONAMES_CN_MANIFEST.contentSha256) {
    throw new Error(`GEONAMES_SNAPSHOT_HASH_MISMATCH: expected ${GEONAMES_CN_MANIFEST.contentSha256}, got ${actualHash}`);
  }
  return GeoNamesChinaSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
}

function immutableSnapshot(snapshot: GeoNamesChinaSnapshot): GeoNamesChinaSnapshot {
  snapshot.cities.forEach((city) => {
    Object.freeze(city.aliases);
    Object.freeze(city.timeZoneSuggestions);
    Object.freeze(city);
  });
  Object.freeze(snapshot.cities);
  return Object.freeze(snapshot);
}

export async function verifyGeoNamesChinaSnapshot(): Promise<boolean> {
  await readVerifiedSnapshot();
  return true;
}

export async function loadGeoNamesChinaSnapshot(): Promise<GeoNamesChinaSnapshot> {
  snapshotPromise ??= readVerifiedSnapshot().then(immutableSnapshot);
  return structuredClone(await snapshotPromise);
}

export async function searchChinaLocations(query: string, limit = 12): Promise<GeoNamesChinaCity[]> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return [];
  }
  snapshotPromise ??= readVerifiedSnapshot().then(immutableSnapshot);
  const snapshot = await snapshotPromise;
  return snapshot.cities
    .map((city) => {
      const terms = [city.nameZh, city.nameLatin, ...city.aliases].map(normalizeSearchText);
      const score = terms.some((term) => term === normalizedQuery)
        ? 0
        : terms.some((term) => term.startsWith(normalizedQuery))
          ? 1
          : terms.some((term) => term.includes(normalizedQuery))
            ? 2
            : Number.POSITIVE_INFINITY;
      return { city, score };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.city.nameZh.localeCompare(right.city.nameZh, "zh-CN"))
    .slice(0, limit)
    .map((entry) => structuredClone(entry.city));
}
