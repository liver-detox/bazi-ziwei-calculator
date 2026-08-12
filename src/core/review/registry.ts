import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ReviewError } from "./errors.js";
import type { ReviewSubject } from "./subject-revision.js";

const FIELD_REGISTRY_URL = new URL("../../data/cyber-saga-field-registry-v1.json", import.meta.url);
const COMPARISON_PROFILE_URL = new URL("../../data/cyber-saga-comparison-profile-v1.json", import.meta.url);
const REFERENCE_KEYSET_URL = new URL("../../data/cyber-saga-reference-keyset-v1.json", import.meta.url);
const FIELD_REGISTRY_V2_URL = new URL("../../data/cyber-saga-field-registry-v2.json", import.meta.url);
const COMPARISON_PROFILE_V2_URL = new URL("../../data/cyber-saga-comparison-profile-v2.json", import.meta.url);
const REFERENCE_KEYSET_V2_URL = new URL("../../data/cyber-saga-reference-keyset-v2.json", import.meta.url);

export const FIELD_REGISTRY_MANIFEST = Object.freeze({
  version: "CyberSaga-Field-Registry-v1",
  contentFile: "src/data/cyber-saga-field-registry-v1.json",
  contentSha256: "77440435a1bd9024d5419904456ba09212d4146e925d02b4f42f549451868ba2"
} as const satisfies ReviewRegistryManifest);

export const COMPARISON_PROFILE_MANIFEST = Object.freeze({
  version: "CyberSaga-Comparison-Profile-v1",
  contentFile: "src/data/cyber-saga-comparison-profile-v1.json",
  contentSha256: "9635856a5da34408316dd08c56c16811deec63c104e814eeea36c600692857cc"
} as const satisfies ReviewRegistryManifest);

export const REFERENCE_KEYSET_MANIFEST = Object.freeze({
  version: "CyberSaga-Reference-Keyset-v1",
  contentFile: "src/data/cyber-saga-reference-keyset-v1.json",
  contentSha256: "48ad556438ae95ff5094814a0a9d36705e6c07705910aab7b1dd27fb97224f3b"
} as const satisfies ReviewRegistryManifest);

export const FIELD_REGISTRY_MANIFEST_V2 = Object.freeze({
  version: "CyberSaga-Field-Registry-v2",
  contentFile: "src/data/cyber-saga-field-registry-v2.json",
  contentSha256: "61d52e631ab6e0ff23be59b2a3b033a689c44918601efc20678bcc5c10e3d9c8"
} as const satisfies ReviewRegistryManifest);

export const COMPARISON_PROFILE_MANIFEST_V2 = Object.freeze({
  version: "CyberSaga-Comparison-Profile-v2",
  contentFile: "src/data/cyber-saga-comparison-profile-v2.json",
  contentSha256: "32399ef54497d533da6f31b787c9acf8a3cf950f68e8c5012fd118481f4fc8d7"
} as const satisfies ReviewRegistryManifest);

export const REFERENCE_KEYSET_MANIFEST_V2 = Object.freeze({
  version: "CyberSaga-Reference-Keyset-v2",
  contentFile: "src/data/cyber-saga-reference-keyset-v2.json",
  contentSha256: "c0a9379277f154748b186c6e1639507d0dddc1eccd5f165a92dd68f702fa2f48"
} as const satisfies ReviewRegistryManifest);

export type ReviewRegistryVersion = "v1" | "v2";

export interface ReviewRegistryIdentity {
  version: ReviewRegistryVersion;
  fieldRegistry: string;
  comparisonProfile: string;
  referenceKeyset: string;
}

export function reviewRegistryIdentityForVersion(version: ReviewRegistryVersion): ReviewRegistryIdentity {
  const manifests = version === "v1"
    ? [FIELD_REGISTRY_MANIFEST, COMPARISON_PROFILE_MANIFEST, REFERENCE_KEYSET_MANIFEST] as const
    : [FIELD_REGISTRY_MANIFEST_V2, COMPARISON_PROFILE_MANIFEST_V2, REFERENCE_KEYSET_MANIFEST_V2] as const;
  return {
    version,
    fieldRegistry: `${manifests[0].version}#sha256:${manifests[0].contentSha256}`,
    comparisonProfile: `${manifests[1].version}#sha256:${manifests[1].contentSha256}`,
    referenceKeyset: `${manifests[2].version}#sha256:${manifests[2].contentSha256}`
  };
}

export function reviewRegistryIdentityForSubject(subject: ReviewSubject): ReviewRegistryIdentity {
  return reviewRegistryIdentityForVersion(subject.subjectContract === "location_time_v1" ? "v1" : "v2");
}

export function parseReviewRegistryIdentity(value: unknown): ReviewRegistryIdentity | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  for (const version of ["v1", "v2"] as const) {
    const expected = reviewRegistryIdentityForVersion(version);
    if (
      raw.fieldRegistry === expected.fieldRegistry
      && raw.comparisonProfile === expected.comparisonProfile
      && raw.referenceKeyset === expected.referenceKeyset
    ) return expected;
  }
  return null;
}

const referenceRegistryBindings = new Map<string, ReviewRegistryIdentity>();

export function bindReferenceRegistryIdentity(
  semanticFingerprint: string,
  identity: ReviewRegistryIdentity
): void {
  const existing = referenceRegistryBindings.get(semanticFingerprint);
  if (existing !== undefined && existing.version !== identity.version) {
    throw new ReviewError("REFERENCE_REGISTRY_IDENTITY_CONFLICT", "参考集注册表身份冲突", 409);
  }
  referenceRegistryBindings.set(semanticFingerprint, Object.freeze({ ...identity }));
}

export function referenceRegistryIdentityForFingerprint(semanticFingerprint: string): ReviewRegistryIdentity {
  const identity = referenceRegistryBindings.get(semanticFingerprint);
  if (identity === undefined) {
    throw new ReviewError("REFERENCE_REGISTRY_IDENTITY_MISSING", "参考集缺少显式注册表身份", 422);
  }
  return { ...identity };
}

const TRACKS = ["time", "bazi", "ziwei"] as const;
const VALUE_TYPES = [
  "string",
  "number",
  "boolean",
  "nullable_string",
  "nullable_number",
  "string_array",
  "number_array",
  "object",
  "nullable_object",
  "object_array"
] as const;
const EXPANSIONS = [
  "single",
  "pillar_position",
  "da_yun",
  "target_year",
  "palace_branch",
  "palace_star"
] as const;
const PILLAR_POSITIONS = ["year", "month", "day", "time"] as const;
const EARTHLY_BRANCHES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"] as const;
const STAR_KINDS = ["major", "minor"] as const;
const EXPECTED_FIELD_TEMPLATES = [
  "time.original.calendar",
  "time.original.localTime",
  "time.zone.timeZone",
  "time.zone.standardOffsetMinutes",
  "time.location.latitude",
  "time.location.longitude",
  "time.location.clockConvention",
  "time.candidate.basis",
  "time.candidate.localDateTime",
  "time.candidate.instant",
  "time.candidate.offset",
  "time.candidate.standardOffset",
  "time.candidate.dstMinutes",
  "time.candidate.earthlyBranch",
  "time.candidate.ziSegment",
  "time.candidate.dayBoundary",
  "time.candidate.calendarBasis",
  "time.candidate.trueSolar.clockLocalDateTime",
  "time.candidate.trueSolar.standardLocalDateTime",
  "time.candidate.trueSolar.dstRemovedMinutes",
  "time.candidate.trueSolar.longitude",
  "time.candidate.trueSolar.standardMeridian",
  "time.candidate.trueSolar.longitudeCorrectionMinutes",
  "time.candidate.trueSolar.equationOfTimeMinutes",
  "time.candidate.trueSolar.totalCorrectionMinutes",
  "time.candidate.trueSolar.adjustedLocalDateTime",
  "time.candidate.warnings",
  "bazi.fourPillars",
  "bazi.pillar.{position}.ganZhi",
  "bazi.pillar.{position}.hiddenStems",
  "bazi.pillar.{position}.stemTenGod",
  "bazi.pillar.{position}.hiddenStemTenGods",
  "bazi.pillar.{position}.naYin",
  "bazi.pillar.{position}.xun",
  "bazi.pillar.{position}.voidBranches",
  "bazi.pillar.{position}.growthStage",
  "bazi.luck.forward",
  "bazi.luck.startSolarDateTime",
  "bazi.luck.startAfter",
  "bazi.luck.daYun.{daYunIndex}.period",
  "bazi.luck.daYun.{daYunIndex}.ganZhi",
  "bazi.luck.daYun.{daYunIndex}.xun",
  "bazi.luck.daYun.{daYunIndex}.voidBranches",
  "bazi.annualFortune.{targetYear}",
  "ziwei.soulPalaceBranch",
  "ziwei.bodyPalaceBranch",
  "ziwei.soul",
  "ziwei.body",
  "ziwei.fiveElementsClass",
  "ziwei.palace.{earthlyBranch}.identity",
  "ziwei.palace.{earthlyBranch}.majorStarNames",
  "ziwei.palace.{earthlyBranch}.minorStarNames",
  "ziwei.palace.{earthlyBranch}.star.{starKind}.{starName}.identity",
  "ziwei.palace.{earthlyBranch}.star.{starKind}.{starName}.brightness",
  "ziwei.palace.{earthlyBranch}.star.{starKind}.{starName}.transformation",
  "ziwei.palace.{earthlyBranch}.changsheng12",
  "ziwei.palace.{earthlyBranch}.decadal",
  "ziwei.palace.{earthlyBranch}.ages",
  "ziwei.transformations",
  "ziwei.yearlyFortune.{targetYear}.decadal",
  "ziwei.yearlyFortune.{targetYear}.yearly"
] as const;

const EXPECTED_FIELD_TEMPLATES_V2 = [
  "time.input.calendar",
  "time.input.localTime",
  "time.input.basis",
  "time.candidate.basis",
  "time.candidate.localDateTime",
  "time.candidate.earthlyBranch",
  "time.candidate.ziSegment",
  "time.candidate.dayBoundary",
  "time.candidate.calendarBasis",
  "time.candidate.warnings",
  ...EXPECTED_FIELD_TEMPLATES.filter((path) => path.startsWith("bazi.") || path.startsWith("ziwei."))
] as const;

const REQUIRED_GROUP_NAMES = [
  "time_identity",
  "bazi_four_pillars",
  "ziwei_core",
  "ziwei_palace_mapping",
  "bazi_luck_start",
  "ziwei_decadal_start"
] as const;

const EXPECTED_REQUIRED_GROUPS = {
  time_identity: [
    "time.original.localTime",
    "time.candidate.earthlyBranch",
    "time.candidate.dayBoundary"
  ],
  bazi_four_pillars: ["bazi.fourPillars"],
  ziwei_core: [
    "ziwei.soulPalaceBranch",
    "ziwei.bodyPalaceBranch",
    "ziwei.fiveElementsClass"
  ],
  ziwei_palace_mapping: [
    "ziwei.palace.{earthlyBranch}.identity",
    "ziwei.palace.{earthlyBranch}.majorStarNames"
  ],
  bazi_luck_start: [
    "bazi.luck.startSolarDateTime",
    "bazi.luck.daYun.1.period",
    "bazi.luck.daYun.1.ganZhi"
  ],
  ziwei_decadal_start: ["ziwei.palace.{earthlyBranch}.decadal"]
} as const;

const EXPECTED_REQUIRED_GROUPS_V2 = {
  ...EXPECTED_REQUIRED_GROUPS,
  time_identity: [
    "time.input.localTime",
    "time.input.basis",
    "time.candidate.earthlyBranch",
    "time.candidate.dayBoundary"
  ]
} as const;

const ReviewFieldSchema = z.object({
  pathTemplate: z.string().min(1),
  track: z.enum(TRACKS),
  displayLabel: z.string().min(1),
  valueType: z.enum(VALUE_TYPES),
  expansion: z.enum(EXPANSIONS)
}).strict();

const FieldRegistrySchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  registryVersion: z.enum(["CyberSaga-Field-Registry-v1", "CyberSaga-Field-Registry-v2"]),
  fields: z.array(ReviewFieldSchema)
}).strict();

const ComparisonProfileSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  profileVersion: z.enum(["CyberSaga-Comparison-Profile-v1", "CyberSaga-Comparison-Profile-v2"]),
  fieldTemplates: z.array(z.string().min(1))
}).strict();

const ReferenceKeysetSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  keysetVersion: z.enum(["CyberSaga-Reference-Keyset-v1", "CyberSaga-Reference-Keyset-v2"]),
  requiredGroups: z.object({
    time_identity: z.array(z.string().min(1)),
    bazi_four_pillars: z.array(z.string().min(1)),
    ziwei_core: z.array(z.string().min(1)),
    ziwei_palace_mapping: z.array(z.string().min(1)),
    bazi_luck_start: z.array(z.string().min(1)),
    ziwei_decadal_start: z.array(z.string().min(1))
  }).strict()
}).strict();

const ReviewRegistriesSchema = z.object({
  fieldRegistry: FieldRegistrySchema,
  comparisonProfile: ComparisonProfileSchema,
  referenceKeyset: ReferenceKeysetSchema
}).strict();

export type ReviewTrack = typeof TRACKS[number];
export type ReviewField = z.infer<typeof ReviewFieldSchema>;
export type FieldRegistryV1 = z.infer<typeof FieldRegistrySchema>;
export type ComparisonProfileV1 = z.infer<typeof ComparisonProfileSchema>;
export type ReferenceKeysetV1 = z.infer<typeof ReferenceKeysetSchema>;
export type ReviewRegistries = z.infer<typeof ReviewRegistriesSchema>;
export type ReferenceKeysetGroup = typeof REQUIRED_GROUP_NAMES[number];

export interface ReviewRegistryExpansionSubject {
  readonly targetYears: readonly number[];
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly bazi: {
      readonly luck: {
        readonly daYun: readonly { readonly index: number }[];
      };
    };
    readonly ziwei: {
      readonly palaces: readonly {
        readonly earthlyBranch: string;
        readonly majorStars: readonly { readonly name: string }[];
        readonly minorStars: readonly { readonly name: string }[];
      }[];
    };
  }[];
}

export interface ResolvedRegisteredField extends ReviewField {
  fieldPath: string;
  parameters: Record<string, string>;
}

export type RequiredKeysetPaths = Record<ReferenceKeysetGroup, string[]>;

function invalidRegistry(message: string): ReviewError {
  return new ReviewError("REVIEW_REGISTRY_INVALID", message, 422);
}

function assertExactArray(actual: readonly string[], expected: readonly string[], name: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw invalidRegistry(`${name} 与冻结规范不一致`);
  }
}

function placeholders(pathTemplate: string): string[] {
  const matches = [...pathTemplate.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]);
  const withoutPlaceholders = pathTemplate.replace(/\{[^{}]+\}/gu, "");
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
    throw invalidRegistry(`字段模板括号不完整: ${pathTemplate}`);
  }
  return matches;
}

function validateFieldSemantics(field: ReviewField): void {
  const expectedTrack = field.pathTemplate.split(".", 1)[0];
  if (field.track !== expectedTrack) {
    throw invalidRegistry(`字段轨道与路径不一致: ${field.pathTemplate}`);
  }
  const expectedPlaceholders: Record<ReviewField["expansion"], readonly string[]> = {
    single: [],
    pillar_position: ["position"],
    da_yun: ["daYunIndex"],
    target_year: ["targetYear"],
    palace_branch: ["earthlyBranch"],
    palace_star: ["earthlyBranch", "starKind", "starName"]
  };
  assertExactArray(placeholders(field.pathTemplate), expectedPlaceholders[field.expansion], field.pathTemplate);
  if (field.valueType === "number_array" && field.pathTemplate !== "ziwei.palace.{earthlyBranch}.ages") {
    throw invalidRegistry("number_array 仅允许用于宫位岁数字段");
  }
  if (field.pathTemplate === "ziwei.palace.{earthlyBranch}.ages" && field.valueType !== "number_array") {
    throw invalidRegistry("宫位岁数必须声明为 number_array");
  }
  if (field.pathTemplate === "time.candidate.dstMinutes" && field.valueType !== "nullable_number") {
    throw invalidRegistry("夏令时分钟必须声明为 nullable_number");
  }
}

export function parseAndValidateReviewRegistries(
  version: ReviewRegistryVersion,
  raw: unknown
): ReviewRegistries {
  const result = ReviewRegistriesSchema.safeParse(raw);
  if (!result.success) {
    throw new ReviewError("REVIEW_REGISTRY_SCHEMA_INVALID", "注册表不符合 strict schema", 400, {
      cause: result.error
    });
  }
  const parsed = result.data;
  const expectedVersions = version === "v1"
    ? {
        field: FIELD_REGISTRY_MANIFEST.version,
        profile: COMPARISON_PROFILE_MANIFEST.version,
        keyset: REFERENCE_KEYSET_MANIFEST.version
      }
    : {
        field: FIELD_REGISTRY_MANIFEST_V2.version,
        profile: COMPARISON_PROFILE_MANIFEST_V2.version,
        keyset: REFERENCE_KEYSET_MANIFEST_V2.version
      };
  if (
    parsed.fieldRegistry.registryVersion !== expectedVersions.field
    || parsed.comparisonProfile.profileVersion !== expectedVersions.profile
    || parsed.referenceKeyset.keysetVersion !== expectedVersions.keyset
  ) throw invalidRegistry("注册表版本与选定契约不一致");
  const expectedTemplates = version === "v1" ? EXPECTED_FIELD_TEMPLATES : EXPECTED_FIELD_TEMPLATES_V2;
  const expectedGroups = version === "v1" ? EXPECTED_REQUIRED_GROUPS : EXPECTED_REQUIRED_GROUPS_V2;
  const templates = parsed.fieldRegistry.fields.map((field) => field.pathTemplate);
  assertExactArray(templates, expectedTemplates, "Field Registry");
  if (new Set(templates).size !== templates.length) {
    throw invalidRegistry("Field Registry 存在重复 pathTemplate");
  }
  parsed.fieldRegistry.fields.forEach(validateFieldSemantics);
  assertExactArray(parsed.comparisonProfile.fieldTemplates, expectedTemplates, "Comparison Profile");
  for (const groupName of REQUIRED_GROUP_NAMES) {
    assertExactArray(
      parsed.referenceKeyset.requiredGroups[groupName],
      expectedGroups[groupName],
      `Reference Keyset ${groupName}`
    );
  }
  for (const fieldPath of Object.values(parsed.referenceKeyset.requiredGroups).flat()) {
    const track = fieldPath.split(".", 1)[0];
    if (!TRACKS.includes(track as ReviewTrack)) {
      throw invalidRegistry(`Keyset 字段轨道无效: ${fieldPath}`);
    }
    if (fieldPath.includes("{")) {
      if (!templates.includes(fieldPath)) {
        throw invalidRegistry(`Keyset 模板未注册: ${fieldPath}`);
      }
    } else {
      resolveAgainstRegistry(track as ReviewTrack, fieldPath, parsed.fieldRegistry);
    }
  }
  return structuredClone(parsed);
}

export type ReviewRegistryManifest = {
  readonly version: string;
  readonly contentFile: string;
  readonly contentSha256: string;
};

async function readHashVerifiedJson(url: URL, manifest: ReviewRegistryManifest): Promise<unknown> {
  const bytes = await readFile(url);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== manifest.contentSha256) {
    throw new ReviewError(
      "REVIEW_REGISTRY_HASH_MISMATCH",
      `${manifest.contentFile} 字节哈希不匹配`,
      409
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new ReviewError("REVIEW_REGISTRY_JSON_INVALID", `${manifest.contentFile} 不是有效 JSON`, 400, {
      cause: error
    });
  }
}

const verifiedRegistries = new Map<ReviewRegistryVersion, Promise<ReviewRegistries>>();

async function readVerifiedReviewRegistries(version: ReviewRegistryVersion): Promise<ReviewRegistries> {
  const selected = version === "v1"
    ? {
        fieldUrl: FIELD_REGISTRY_URL,
        fieldManifest: FIELD_REGISTRY_MANIFEST,
        profileUrl: COMPARISON_PROFILE_URL,
        profileManifest: COMPARISON_PROFILE_MANIFEST,
        keysetUrl: REFERENCE_KEYSET_URL,
        keysetManifest: REFERENCE_KEYSET_MANIFEST
      }
    : {
        fieldUrl: FIELD_REGISTRY_V2_URL,
        fieldManifest: FIELD_REGISTRY_MANIFEST_V2,
        profileUrl: COMPARISON_PROFILE_V2_URL,
        profileManifest: COMPARISON_PROFILE_MANIFEST_V2,
        keysetUrl: REFERENCE_KEYSET_V2_URL,
        keysetManifest: REFERENCE_KEYSET_MANIFEST_V2
      };
  const [fieldRegistry, comparisonProfile, referenceKeyset] = await Promise.all([
    readHashVerifiedJson(selected.fieldUrl, selected.fieldManifest),
    readHashVerifiedJson(selected.profileUrl, selected.profileManifest),
    readHashVerifiedJson(selected.keysetUrl, selected.keysetManifest)
  ]);
  return parseAndValidateReviewRegistries(version, { fieldRegistry, comparisonProfile, referenceKeyset });
}

export async function loadReviewRegistries(version: ReviewRegistryVersion): Promise<ReviewRegistries> {
  const cached = verifiedRegistries.get(version) ?? readVerifiedReviewRegistries(version);
  verifiedRegistries.set(version, cached);
  return structuredClone(await cached);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function placeholderPattern(name: string): string {
  switch (name) {
    case "position":
      return `(${PILLAR_POSITIONS.join("|")})`;
    case "daYunIndex":
      return "(0|[1-9][0-9]*)";
    case "targetYear":
      return "((?:19|20)[0-9]{2})";
    case "earthlyBranch":
      return `(${EARTHLY_BRANCHES.join("|")})`;
    case "starKind":
      return `(${STAR_KINDS.join("|")})`;
    case "starName":
      return "([^./\\\\{}\\[\\]]+)";
    default:
      throw invalidRegistry(`未知 placeholder: ${name}`);
  }
}

function compileTemplate(pathTemplate: string): { regex: RegExp; parameterNames: string[] } {
  const parameterNames: string[] = [];
  const source = pathTemplate.split(".").map((segment) => {
    const match = /^\{([^{}]+)\}$/u.exec(segment);
    if (match === null) return escapeRegex(segment);
    parameterNames.push(match[1]);
    return placeholderPattern(match[1]);
  }).join("\\.");
  return { regex: new RegExp(`^${source}$`, "u"), parameterNames };
}

function resolveAgainstRegistry(
  track: ReviewTrack,
  fieldPath: string,
  registry: FieldRegistryV1
): ResolvedRegisteredField {
  const matches: Array<{ field: ReviewField; parameters: Record<string, string> }> = [];
  for (const field of registry.fields) {
    if (field.track !== track) continue;
    const compiled = compileTemplate(field.pathTemplate);
    const match = compiled.regex.exec(fieldPath);
    if (match === null) continue;
    const parameters = Object.fromEntries(
      compiled.parameterNames.map((name, index) => [name, match[index + 1]])
    );
    matches.push({ field, parameters });
  }
  if (matches.length === 0) {
    throw new ReviewError("REVIEW_FIELD_NOT_REGISTERED", `未注册字段: ${track}/${fieldPath}`, 422);
  }
  if (matches.length !== 1) {
    throw new ReviewError("REVIEW_FIELD_AMBIGUOUS", `字段模板不能唯一解析: ${track}/${fieldPath}`, 422);
  }
  const match = matches[0];
  return structuredClone({ ...match.field, fieldPath, parameters: match.parameters });
}

export async function resolveRegisteredField(
  version: ReviewRegistryVersion,
  track: ReviewTrack,
  fieldPath: string
): Promise<ResolvedRegisteredField> {
  const { fieldRegistry } = await loadReviewRegistries(version);
  return resolveAgainstRegistry(track, fieldPath, fieldRegistry);
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function isValidStarName(name: string): boolean {
  return name.length > 0 && !/[./\\{}\[\]]/u.test(name);
}

type SubjectEntities = {
  daYunIndices: number[];
  targetYears: number[];
  starsByBranch: Map<string, Record<typeof STAR_KINDS[number], string[]>>;
};

function subjectEntities(
  subject: ReviewRegistryExpansionSubject,
  candidateId: string
): SubjectEntities {
  const candidates = subject.candidates.filter((candidate) => candidate.candidateId === candidateId);
  if (candidates.length !== 1) {
    throw new ReviewError(
      candidates.length === 0 ? "REVIEW_CANDIDATE_NOT_FOUND" : "REVIEW_CANDIDATE_AMBIGUOUS",
      `候选引用必须唯一存在: ${candidateId}`,
      422
    );
  }
  const candidate = candidates[0];
  const targetYears = [...subject.targetYears];
  if (
    targetYears.some((year) => !Number.isInteger(year) || year < 1900 || year > 2099)
    || new Set(targetYears).size !== targetYears.length
  ) {
    throw new ReviewError("REVIEW_TARGET_YEARS_INVALID", "targetYears 必须是 1900..2099 内唯一整数", 422);
  }
  targetYears.sort((left, right) => left - right);

  const daYunIndices = candidate.bazi.luck.daYun.map((item) => item.index);
  if (
    daYunIndices.some((index) => !Number.isSafeInteger(index) || index < 0)
    || new Set(daYunIndices).size !== daYunIndices.length
  ) {
    throw new ReviewError("REVIEW_DA_YUN_INDEX_INVALID", "大运 index 必须是盘内唯一非负安全整数", 422);
  }
  daYunIndices.sort((left, right) => left - right);

  const palacesByBranch = new Map(candidate.ziwei.palaces.map((palace) => [palace.earthlyBranch, palace]));
  if (
    candidate.ziwei.palaces.length !== EARTHLY_BRANCHES.length
    || palacesByBranch.size !== EARTHLY_BRANCHES.length
    || EARTHLY_BRANCHES.some((branch) => !palacesByBranch.has(branch))
  ) {
    throw new ReviewError("REVIEW_PALACE_BRANCH_INVALID", "紫微宫位必须以十二地支唯一完整标识", 422);
  }
  const starsByBranch = new Map<string, Record<typeof STAR_KINDS[number], string[]>>();
  for (const branch of EARTHLY_BRANCHES) {
    const palace = palacesByBranch.get(branch);
    if (palace === undefined) throw new ReviewError("REVIEW_PALACE_BRANCH_INVALID", `缺少宫位: ${branch}`, 422);
    const starNames = {
      major: palace.majorStars.map((star) => star.name),
      minor: palace.minorStars.map((star) => star.name)
    };
    for (const kind of STAR_KINDS) {
      if (
        starNames[kind].some((name) => !isValidStarName(name))
        || new Set(starNames[kind]).size !== starNames[kind].length
      ) {
        throw new ReviewError(
          "REVIEW_STAR_NAME_INVALID",
          `${branch}/${kind} 星名必须唯一且不含路径分隔符`,
          422
        );
      }
      starNames[kind].sort(compareUnicodeCodePoints);
    }
    starsByBranch.set(branch, starNames);
  }
  return { daYunIndices, targetYears, starsByBranch };
}

function parameterSets(field: ReviewField, entities: SubjectEntities): Array<Record<string, string>> {
  switch (field.expansion) {
    case "single":
      return [{}];
    case "pillar_position":
      return PILLAR_POSITIONS.map((position) => ({ position }));
    case "da_yun":
      return entities.daYunIndices.map((daYunIndex) => ({ daYunIndex: String(daYunIndex) }));
    case "target_year":
      return entities.targetYears.map((targetYear) => ({ targetYear: String(targetYear) }));
    case "palace_branch":
      return EARTHLY_BRANCHES.map((earthlyBranch) => ({ earthlyBranch }));
    case "palace_star":
      return EARTHLY_BRANCHES.flatMap((earthlyBranch) => STAR_KINDS.flatMap((starKind) => {
        const stars = entities.starsByBranch.get(earthlyBranch)?.[starKind];
        if (stars === undefined) throw new ReviewError("REVIEW_PALACE_BRANCH_INVALID", `缺少宫位: ${earthlyBranch}`, 422);
        return stars.map((starName) => ({ earthlyBranch, starKind, starName }));
      }));
  }
}

function expandTemplate(pathTemplate: string, parameters: Record<string, string>): string {
  return pathTemplate.replace(/\{([^{}]+)\}/gu, (_placeholder, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw invalidRegistry(`缺少模板参数: ${name}`);
    return value;
  });
}

export async function expandComparisonProfile(
  version: ReviewRegistryVersion,
  subject: ReviewRegistryExpansionSubject,
  candidateId: string
): Promise<ResolvedRegisteredField[]> {
  const registries = await loadReviewRegistries(version);
  const entities = subjectEntities(subject, candidateId);
  const fieldsByTemplate = new Map(
    registries.fieldRegistry.fields.map((field) => [field.pathTemplate, field])
  );
  const expanded: ResolvedRegisteredField[] = [];
  for (const pathTemplate of registries.comparisonProfile.fieldTemplates) {
    const field = fieldsByTemplate.get(pathTemplate);
    if (field === undefined) throw invalidRegistry(`Profile 模板未注册: ${pathTemplate}`);
    for (const parameters of parameterSets(field, entities)) {
      const fieldPath = expandTemplate(pathTemplate, parameters);
      expanded.push(resolveAgainstRegistry(field.track, fieldPath, registries.fieldRegistry));
    }
  }
  const paths = expanded.map((field) => field.fieldPath);
  if (new Set(paths).size !== paths.length) {
    throw invalidRegistry("Comparison Profile 展开后字段路径重复");
  }
  const sorted = [...expanded].sort((left, right) => compareUnicodeCodePoints(left.fieldPath, right.fieldPath));
  return structuredClone(sorted);
}

export function requiredKeysetPathsForVersion(version: ReviewRegistryVersion): RequiredKeysetPaths {
  const expectedGroups = version === "v1" ? EXPECTED_REQUIRED_GROUPS : EXPECTED_REQUIRED_GROUPS_V2;
  const result = {} as RequiredKeysetPaths;
  for (const groupName of REQUIRED_GROUP_NAMES) {
    result[groupName] = expectedGroups[groupName].flatMap((pathTemplate) => (
      pathTemplate.includes("{earthlyBranch}")
        ? EARTHLY_BRANCHES.map((earthlyBranch) => expandTemplate(pathTemplate, { earthlyBranch }))
        : [pathTemplate]
    )).sort(compareUnicodeCodePoints);
  }
  return structuredClone(result);
}

export function requiredKeysetPathsV1(): RequiredKeysetPaths {
  return requiredKeysetPathsForVersion("v1");
}

export async function requiredKeysetPaths(
  version: ReviewRegistryVersion,
  subject: ReviewRegistryExpansionSubject,
  candidateId: string
): Promise<RequiredKeysetPaths> {
  const registries = await loadReviewRegistries(version);
  const entities = subjectEntities(subject, candidateId);
  if (!entities.daYunIndices.includes(1)) {
    throw new ReviewError("REVIEW_REQUIRED_DA_YUN_MISSING", "关键覆盖要求盘内存在大运 index 1", 422);
  }
  const expectedGroups = version === "v1" ? EXPECTED_REQUIRED_GROUPS : EXPECTED_REQUIRED_GROUPS_V2;
  const result = {} as RequiredKeysetPaths;
  for (const groupName of REQUIRED_GROUP_NAMES) {
    result[groupName] = expectedGroups[groupName].flatMap((pathTemplate) => (
      pathTemplate.includes("{earthlyBranch}")
        ? EARTHLY_BRANCHES.map((earthlyBranch) => expandTemplate(pathTemplate, { earthlyBranch }))
        : [pathTemplate]
    )).sort(compareUnicodeCodePoints);
  }
  for (const paths of Object.values(result)) {
    for (const fieldPath of paths) {
      const track = fieldPath.split(".", 1)[0] as ReviewTrack;
      resolveAgainstRegistry(track, fieldPath, registries.fieldRegistry);
    }
  }
  return structuredClone(result);
}
