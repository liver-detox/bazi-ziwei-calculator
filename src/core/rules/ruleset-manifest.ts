import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { canonicalize } from "json-canonicalize";
import { z } from "zod";

import { XINJIANG_LOCATION_RULE_V1 } from "../../shared/clock-convention.js";

const RULESET_SNAPSHOT_URL = new URL("../../data/rulesets-v1.json", import.meta.url);

export const RULESET_SNAPSHOT_MANIFEST = Object.freeze({
  snapshotVersion: "CyberSaga-Rulesets-v1",
  contentFile: "src/data/rulesets-v1.json",
  contentSha256: "bcbf6e4cbe0d0c1d10623c0f600afacd2908ffde14f8f3afa6b091ff6a6758a7"
} as const);

// SHA-256 of json-canonicalize@2.0.0 output for each named section below.
// The verification test recomputes these from the checked-in, whole-file-verified snapshot.
export function canonicalRulesetContentSha256(value: unknown): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== "string") {
    throw new TypeError("规则内容无法序列化为规范 JSON");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const XINJIANG_LOCATION_RULE_EVIDENCE = Object.freeze({
  ruleId: XINJIANG_LOCATION_RULE_V1.ruleId,
  rulesetVersion: XINJIANG_LOCATION_RULE_V1.rulesetVersion,
  contentSha256: canonicalRulesetContentSha256(XINJIANG_LOCATION_RULE_V1)
} as const);

export const RULESET_SECTION_SHA256 = Object.freeze({
  audit: "d5943386a7dfe01337348edecda6e47d0a071f2e25b5d10ad24cb95f6d735ea3",
  time: "9af1d2364106fd80c111a97ff6cc67ab7f90302845b2b6d5ae84fa36eb0977a5",
  bazi: "057d7b4604b6720dbdb07f21598c11e86839fff1edbaf96e1f007cd8b126f2e2",
  ziwei: "2e9be838b610f9a3f7d87c76c2ea9ef94f2ffc2eb1fa80f2a2160436e4fbb62b",
  xinjiangLocation: XINJIANG_LOCATION_RULE_EVIDENCE.contentSha256
} as const);

const RulesetSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  snapshotVersion: z.literal("CyberSaga-Rulesets-v1"),
  time: z.object({
    version: z.literal("CyberSaga-Time-v1"),
    timezoneDatabase: z.literal("@js-joda/timezone@2.25.2#2026a"),
    standardOffsetRuleset: z.literal("CyberSaga-StandardOffset-v1"),
    trueSolarAlgorithm: z.string().min(1),
    lateZiDefault: z.literal("parallel-current-and-forward"),
    supportedYears: z.tuple([z.literal(1900), z.literal(2099)])
  }).strict(),
  xinjiangLocation: z.object({
    ruleId: z.literal("xinjiang-clock-convention-confirmation"),
    rulesetVersion: z.literal("CyberSaga-Xinjiang-Location-v1"),
    countryCode: z.literal("CN"),
    alwaysConfirmTimeZones: z.tuple([z.literal("Asia/Urumqi")]),
    geoNamesSnapshotVersion: z.literal("GeoNames-CN-major-cities-v1"),
    geoNamesSnapshotSha256: z.literal("bb614978c8ad21b5ba2a47efaf99a16379e5cdaf635017f053626e6571ac835d"),
    geoNamesCoordinateKind: z.literal("representative"),
    trustedGeoNameIds: z.tuple([z.literal(1529102)]),
    conservativeBounds: z.object({
      minLatitude: z.literal(34),
      maxLatitude: z.literal(49.5),
      minLongitude: z.literal(73),
      maxLongitude: z.literal(96.5)
    }).strict(),
    longitudeOnlyWithinBoundsRequiresConfirmation: z.literal(true)
  }).strict(),
  bazi: z.object({
    version: z.literal("CyberSaga-Bazi-v1"),
    engine: z.literal("lunar-typescript@1.8.6"),
    yearBoundary: z.literal("li_chun"),
    monthBoundary: z.literal("solar_terms"),
    luckSect: z.literal(1),
    lateZiCurrentPillarSect: z.literal(2),
    lateZiForwardPillarSect: z.literal(1),
    included: z.array(z.string().min(1)).min(1),
    excluded: z.array(z.string().min(1)).min(1)
  }).strict(),
  ziwei: z.object({
    version: z.literal("CyberSaga-Ziwei-v1"),
    engine: z.literal("iztro@2.5.8"),
    algorithm: z.literal("default"),
    yearDivide: z.literal("normal"),
    horoscopeDivide: z.literal("normal"),
    ageDivide: z.literal("normal"),
    astroType: z.literal("heaven"),
    fixLeap: z.literal(true),
    language: z.literal("zh-CN"),
    lateZiForwardInvocation: z.literal("next-day-early-zi"),
    included: z.array(z.string().min(1)).min(1),
    excluded: z.array(z.string().min(1)).min(1)
  }).strict(),
  audit: z.object({
    version: z.literal("CyberSaga-Audit-v1"),
    levelOrder: z.tuple([z.literal("A"), z.literal("B"), z.literal("C"), z.literal("D")]),
    workflowStates: z.tuple([
      z.literal("draft"),
      z.literal("review"),
      z.literal("verified"),
      z.literal("void")
    ]),
    workflowDoesNotLowerAuditLevel: z.literal(true),
    manualDecisionDoesNotEraseCandidates: z.literal(true),
    failClosedOnUnknownEvidence: z.literal(true)
  }).strict()
}).strict();

export type RulesetSnapshotV1 = z.infer<typeof RulesetSnapshotSchema>;

let verifiedSnapshot: Promise<RulesetSnapshotV1> | undefined;

async function readVerifiedSnapshot(): Promise<RulesetSnapshotV1> {
  const bytes = await readFile(RULESET_SNAPSHOT_URL);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== RULESET_SNAPSHOT_MANIFEST.contentSha256) {
    throw new Error(`RULESET_SNAPSHOT_HASH_MISMATCH: expected ${RULESET_SNAPSHOT_MANIFEST.contentSha256}, got ${actualHash}`);
  }
  const snapshot = RulesetSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (canonicalize(snapshot.xinjiangLocation) !== canonicalize(XINJIANG_LOCATION_RULE_V1)) {
    throw new Error("RULESET_EXECUTABLE_SECTION_MISMATCH: xinjiangLocation");
  }
  return snapshot;
}

export async function loadRulesetSnapshot(): Promise<RulesetSnapshotV1> {
  verifiedSnapshot ??= readVerifiedSnapshot();
  return structuredClone(await verifiedSnapshot);
}

export async function verifyRulesetSnapshot(): Promise<boolean> {
  await readVerifiedSnapshot();
  return true;
}
