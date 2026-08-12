import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  GeoNamesAdminPlaceSnapshotV2Schema,
  type GeoNamesAdminPlaceV2
} from "../src/shared/admin-place-contracts.js";
import { canonicalJson, sha256Bytes, sha256File } from "../src/core/storage/canonical.js";

const SOURCE_FILE_NAMES = [
  "CN.txt",
  "alternateNames-CN.txt",
  "admin1CodesASCII.txt",
  "admin2Codes.txt"
] as const;

const SELECTABLE_ADMIN_CODES = new Set(["ADM2", "ADM3", "ADM4"]);
const PARENT_ADMIN_CODES = new Set(["ADM1", "ADM2", "ADM3", "ADM4"]);
const ALIAS_ONLY_CODES = new Set(["PPLA2", "PPLA3", "PPLA4"]);
const DIRECT_MUNICIPALITIES = new Set(["北京市", "天津市", "上海市", "重庆市"]);
const XINJIANG_BOUNDS = Object.freeze({
  minLatitude: 34,
  maxLatitude: 49.5,
  minLongitude: 73,
  maxLongitude: 96.5
});

type SourceFileName = typeof SOURCE_FILE_NAMES[number];

interface RawGeoRecord {
  geonameId: number;
  nameLatin: string;
  latitude: number;
  longitude: number;
  featureClass: string;
  featureCode: string;
  countryCode: string;
  admin1Code: string;
  admin2Code: string;
  admin3Code: string;
  admin4Code: string;
  timeZone: string;
}

interface AlternateName {
  language: string;
  value: string;
  preferred: boolean;
}

export interface GeoNamesAdminBuildInput {
  sourceDirectory: string;
  retrievedAt: string;
  outputDataFile: string;
  outputManifestModule: string;
}

export interface GeoNamesAdminBuildReport {
  snapshotVersion: "GeoNames-CN-admin-places-v2";
  placeCount: number;
  contentSha256: string;
  outputDataFile: string;
  outputManifestModule: string;
  sourceFiles: ReadonlyArray<{
    name: SourceFileName;
    byteLength: number;
    sha256: string;
  }>;
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

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} 必须是正整数`);
  return parsed;
}

function finiteCoordinate(value: string, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label} 坐标无效`);
  }
  return parsed;
}

async function forEachLine(filePath: string, visit: (line: string, lineNumber: number) => void): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length > 0) visit(line, lineNumber);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseGeoRecord(line: string, lineNumber: number): RawGeoRecord {
  const fields = line.split("\t");
  if (fields.length < 19) throw new TypeError(`CN.txt 第 ${lineNumber} 行字段不足`);
  const geonameId = positiveInteger(fields[0], `CN.txt 第 ${lineNumber} 行 geonameId`);
  return {
    geonameId,
    nameLatin: (fields[2] || fields[1]).trim(),
    latitude: finiteCoordinate(fields[4], -90, 90, `CN.txt 第 ${lineNumber} 行纬度`),
    longitude: finiteCoordinate(fields[5], -180, 180, `CN.txt 第 ${lineNumber} 行经度`),
    featureClass: fields[6],
    featureCode: fields[7],
    countryCode: fields[8],
    admin1Code: fields[10],
    admin2Code: fields[11],
    admin3Code: fields[12],
    admin4Code: fields[13],
    timeZone: fields[17].trim()
  };
}

async function loadGeoRecords(filePath: string): Promise<Map<number, RawGeoRecord>> {
  const records = new Map<number, RawGeoRecord>();
  const seenChinaIds = new Set<number>();
  await forEachLine(filePath, (line, lineNumber) => {
    const record = parseGeoRecord(line, lineNumber);
    if (record.countryCode !== "CN") return;
    if (seenChinaIds.has(record.geonameId)) throw new TypeError(`重复 GeoNames id: ${record.geonameId}`);
    seenChinaIds.add(record.geonameId);
    const relevantParent = record.featureClass === "A" && PARENT_ADMIN_CODES.has(record.featureCode);
    const relevantAlias = record.featureClass === "P" && ALIAS_ONLY_CODES.has(record.featureCode);
    if (!relevantParent && !relevantAlias) return;
    if (record.nameLatin.length === 0) throw new TypeError(`GeoNames ${record.geonameId} 缺少拉丁名称`);
    if (record.timeZone.length === 0) throw new TypeError(`GeoNames ${record.geonameId} 缺少时区`);
    records.set(record.geonameId, record);
  });
  return records;
}

async function loadCodeMap(filePath: string, label: string): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await forEachLine(filePath, (line, lineNumber) => {
    const fields = line.split("\t");
    if (fields.length < 4) throw new TypeError(`${label} 第 ${lineNumber} 行字段不足`);
    if (!fields[0].startsWith("CN.")) return;
    if (result.has(fields[0])) throw new TypeError(`${label} 重复 code: ${fields[0]}`);
    result.set(fields[0], positiveInteger(fields[3], `${label} 第 ${lineNumber} 行 geonameId`));
  });
  return result;
}

async function loadAlternates(
  filePath: string,
  relevantIds: ReadonlySet<number>
): Promise<Map<number, AlternateName[]>> {
  const result = new Map<number, AlternateName[]>();
  await forEachLine(filePath, (line, lineNumber) => {
    const fields = line.split("\t");
    if (fields.length < 8) throw new TypeError(`alternateNames-CN.txt 第 ${lineNumber} 行字段不足`);
    const geonameId = positiveInteger(fields[1], `alternateNames-CN.txt 第 ${lineNumber} 行 geonameId`);
    if (!relevantIds.has(geonameId)) return;
    const value = fields[3].normalize("NFKC").trim();
    if (value.length === 0) return;
    const names = result.get(geonameId) ?? [];
    names.push({ language: fields[2], value, preferred: fields[4] === "1" });
    result.set(geonameId, names);
  });
  return result;
}

function adminDepth(record: RawGeoRecord): 1 | 2 | 3 | 4 {
  const match = /^ADM([1-4])$/u.exec(record.featureCode);
  if (match === null) throw new TypeError(`GeoNames ${record.geonameId} 不是行政记录`);
  return Number(match[1]) as 1 | 2 | 3 | 4;
}

function adminCodeKey(record: RawGeoRecord, depth: 1 | 2 | 3 | 4): string {
  const codes = [record.admin1Code, record.admin2Code, record.admin3Code, record.admin4Code].slice(0, depth);
  if (codes.some((code) => code.length === 0)) {
    throw new TypeError(`GeoNames ${record.geonameId} 缺少 ADM${depth} 行政代码`);
  }
  return `CN.${codes.join(".")}`;
}

function indexAdministrativeRecords(records: ReadonlyMap<number, RawGeoRecord>): Map<string, RawGeoRecord> {
  const result = new Map<string, RawGeoRecord>();
  for (const record of records.values()) {
    if (record.featureClass !== "A" || !PARENT_ADMIN_CODES.has(record.featureCode)) continue;
    const key = adminCodeKey(record, adminDepth(record));
    const existing = result.get(key);
    if (existing !== undefined) {
      throw new TypeError(`行政代码 ${key} 同时指向 GeoNames ${existing.geonameId} 与 ${record.geonameId}`);
    }
    result.set(key, record);
  }
  return result;
}

function requireAdministrativeAncestor(
  child: RawGeoRecord,
  depth: 1 | 2 | 3 | 4,
  recordsByCode: ReadonlyMap<string, RawGeoRecord>
): RawGeoRecord {
  const key = adminCodeKey(child, depth);
  const ancestor = recordsByCode.get(key);
  if (ancestor === undefined || ancestor.featureCode !== `ADM${depth}`) {
    throw new TypeError(`GeoNames ${child.geonameId} 缺少受验 ADM${depth} parent ${key}`);
  }
  return ancestor;
}

function assertCodeTableIdentity(
  child: RawGeoRecord,
  key: string,
  expected: RawGeoRecord,
  codeMap: ReadonlyMap<string, number>
): void {
  const tableId = codeMap.get(key);
  if (tableId === undefined || tableId !== expected.geonameId) {
    throw new TypeError(`GeoNames ${child.geonameId} 的行政表 parent ${key} 不一致`);
  }
}

function verifiedChineseName(geonameId: number, alternates: ReadonlyMap<number, AlternateName[]>): string {
  const chinese = (alternates.get(geonameId) ?? []).filter((name) => name.language === "zh");
  const preferred = chinese.filter((name) => name.preferred);
  const candidates = (preferred.length > 0 ? preferred : chinese)
    .map((name) => name.value)
    .sort(compareUnicodeCodePoints);
  const selected = candidates[0];
  if (selected === undefined) throw new TypeError(`GeoNames ${geonameId} 缺少受验中文名称`);
  return selected;
}

function countyLevelType(nameZh: string): GeoNamesAdminPlaceV2["placeType"] {
  if (nameZh.endsWith("区")) return "district";
  if (nameZh.endsWith("自治县") || nameZh.endsWith("县")) return "county";
  if (nameZh.endsWith("市")) return "county_level_city";
  if (["自治旗", "旗", "特区", "林区"].some((suffix) => nameZh.endsWith(suffix))) {
    return "other_county_level";
  }
  throw new TypeError(`无法根据受验中文后缀判定县级类型: ${nameZh}`);
}

function compactAdjacentLevels(levels: readonly string[]): string {
  return levels.filter((level, index) => index === 0 || level !== levels[index - 1]).join("");
}

function adminTuple(record: RawGeoRecord): string {
  const depth = Number(record.featureCode.at(-1));
  const values = [record.admin1Code, record.admin2Code, record.admin3Code, record.admin4Code];
  return values.slice(0, depth).join("\u0000");
}

function aliasesFor(
  record: RawGeoRecord,
  selectedName: string,
  alternates: ReadonlyMap<number, AlternateName[]>,
  aliasRows: readonly RawGeoRecord[]
): string[] {
  const values = new Set<string>([selectedName]);
  const append = (geonameId: number): void => {
    for (const name of alternates.get(geonameId) ?? []) {
      if (name.language === "zh" || name.language.toLocaleLowerCase("en") === "pinyin") {
        values.add(name.value);
      }
    }
  };
  append(record.geonameId);
  for (const aliasRow of aliasRows) {
    append(aliasRow.geonameId);
    values.add(aliasRow.nameLatin);
  }
  return [...values].sort(compareUnicodeCodePoints);
}

function needsXinjiangConfirmation(latitude: number, longitude: number, timeZone: string): boolean {
  return timeZone === "Asia/Urumqi"
    || (latitude >= XINJIANG_BOUNDS.minLatitude
      && latitude <= XINJIANG_BOUNDS.maxLatitude
      && longitude >= XINJIANG_BOUNDS.minLongitude
      && longitude <= XINJIANG_BOUNDS.maxLongitude);
}

function sourcePath(sourceDirectory: string, name: SourceFileName): string {
  return join(sourceDirectory, name);
}

async function sourceEvidence(sourceDirectory: string): Promise<GeoNamesAdminBuildReport["sourceFiles"]> {
  return Promise.all(SOURCE_FILE_NAMES.map(async (name) => {
    const filePath = sourcePath(sourceDirectory, name);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new TypeError(`GeoNames 输入不是普通文件: ${name}`);
    return { name, byteLength: metadata.size, sha256: await sha256File(filePath) };
  }));
}

function buildManifestModule(manifest: Record<string, unknown>): string {
  const literal = canonicalJson(manifest).trimEnd();
  return `export const GEONAMES_ADMIN_V2_MANIFEST = Object.freeze(${literal});\n`;
}

export async function buildGeoNamesAdminArtifacts(
  input: GeoNamesAdminBuildInput
): Promise<GeoNamesAdminBuildReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.retrievedAt)) {
    throw new TypeError("retrievedAt 必须是 YYYY-MM-DD");
  }
  if (basename(input.outputDataFile) === basename(input.outputManifestModule)) {
    throw new TypeError("数据文件与 manifest module 不得使用同一目标");
  }

  const sourceFiles = await sourceEvidence(input.sourceDirectory);
  const records = await loadGeoRecords(sourcePath(input.sourceDirectory, "CN.txt"));
  const relevantIds = new Set(records.keys());
  const [admin1Codes, admin2Codes, alternates] = await Promise.all([
    loadCodeMap(sourcePath(input.sourceDirectory, "admin1CodesASCII.txt"), "admin1CodesASCII.txt"),
    loadCodeMap(sourcePath(input.sourceDirectory, "admin2Codes.txt"), "admin2Codes.txt"),
    loadAlternates(sourcePath(input.sourceDirectory, "alternateNames-CN.txt"), relevantIds)
  ]);
  const administrativeRecords = indexAdministrativeRecords(records);

  const aliasRowsByTuple = new Map<string, RawGeoRecord[]>();
  for (const record of records.values()) {
    if (!ALIAS_ONLY_CODES.has(record.featureCode)) continue;
    const rows = aliasRowsByTuple.get(adminTuple(record)) ?? [];
    rows.push(record);
    aliasRowsByTuple.set(adminTuple(record), rows);
  }

  const places: GeoNamesAdminPlaceV2[] = [];
  for (const record of records.values()) {
    if (!SELECTABLE_ADMIN_CODES.has(record.featureCode)) continue;
    const admin1Key = `CN.${record.admin1Code}`;
    const admin1 = requireAdministrativeAncestor(record, 1, administrativeRecords);
    assertCodeTableIdentity(record, admin1Key, admin1, admin1Codes);
    const admin1Zh = verifiedChineseName(admin1.geonameId, alternates);
    const nameZh = verifiedChineseName(record.geonameId, alternates);

    let admin2Zh: string;
    let placeType: GeoNamesAdminPlaceV2["placeType"];
    let fullNameZh: string;
    if (record.featureCode === "ADM2") {
      const admin2Key = `CN.${record.admin1Code}.${record.admin2Code}`;
      const ownAdmin2 = requireAdministrativeAncestor(record, 2, administrativeRecords);
      if (ownAdmin2.geonameId !== record.geonameId) {
        throw new TypeError(`GeoNames ${record.geonameId} 的 ADM2 行政代码不一致`);
      }
      assertCodeTableIdentity(record, admin2Key, ownAdmin2, admin2Codes);
      admin2Zh = nameZh;
      placeType = DIRECT_MUNICIPALITIES.has(admin1Zh) ? countyLevelType(nameZh) : "prefecture";
      fullNameZh = compactAdjacentLevels([admin1Zh, nameZh]);
    } else {
      const admin2Key = `CN.${record.admin1Code}.${record.admin2Code}`;
      const admin2 = requireAdministrativeAncestor(record, 2, administrativeRecords);
      assertCodeTableIdentity(record, admin2Key, admin2, admin2Codes);
      const depth = adminDepth(record);
      for (let ancestorDepth = 3; ancestorDepth < depth; ancestorDepth += 1) {
        requireAdministrativeAncestor(record, ancestorDepth as 3 | 4, administrativeRecords);
      }
      const ownRecord = requireAdministrativeAncestor(record, depth, administrativeRecords);
      if (ownRecord.geonameId !== record.geonameId) {
        throw new TypeError(`GeoNames ${record.geonameId} 的 ${record.featureCode} 行政代码不一致`);
      }
      admin2Zh = verifiedChineseName(admin2.geonameId, alternates);
      placeType = countyLevelType(nameZh);
      fullNameZh = compactAdjacentLevels([admin1Zh, admin2Zh, nameZh]);
    }

    const requiresClockConventionConfirmation = needsXinjiangConfirmation(
      record.latitude,
      record.longitude,
      record.timeZone
    );
    const timeZoneSuggestions = requiresClockConventionConfirmation
      ? ["Asia/Shanghai", "Asia/Urumqi"]
      : [record.timeZone];
    places.push({
      geonameId: record.geonameId,
      nameZh,
      fullNameZh,
      nameLatin: record.nameLatin,
      aliases: aliasesFor(record, nameZh, alternates, aliasRowsByTuple.get(adminTuple(record)) ?? []),
      admin1Zh,
      admin2Zh,
      placeType,
      latitude: record.latitude,
      longitude: record.longitude,
      timeZoneSuggestions,
      requiresClockConventionConfirmation,
      coordinateKind: "representative"
    });
  }
  places.sort((left, right) => compareUnicodeCodePoints(left.fullNameZh, right.fullNameZh)
    || left.geonameId - right.geonameId);

  const snapshot = GeoNamesAdminPlaceSnapshotV2Schema.parse({
    schemaVersion: "2.0.0",
    snapshotVersion: "GeoNames-CN-admin-places-v2",
    countryCode: "CN",
    places
  });
  const snapshotBytes = canonicalJson(snapshot);
  const contentSha256 = sha256Bytes(snapshotBytes);
  const manifest = {
    schemaVersion: "2.0.0",
    snapshotVersion: "GeoNames-CN-admin-places-v2",
    countryCode: "CN",
    retrievedAt: input.retrievedAt,
    sourceDataset: "GeoNames official China features, China alternate names, and administrative code tables",
    sourceUrls: [
      "https://download.geonames.org/export/dump/CN.zip",
      "https://download.geonames.org/export/dump/alternatenames/CN.zip",
      "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
      "https://download.geonames.org/export/dump/admin2Codes.txt"
    ],
    license: "CC BY 4.0",
    attribution: "Contains information from GeoNames (www.geonames.org), licensed under CC BY 4.0.",
    representativePointOnly: true,
    placeCount: snapshot.places.length,
    contentFile: "src/data/geonames-cn-admin-places.v2.json",
    contentSha256,
    sourceFiles
  };

  await writeFile(input.outputDataFile, snapshotBytes, { encoding: "utf8", mode: 0o600 });
  await writeFile(input.outputManifestModule, buildManifestModule(manifest), { encoding: "utf8", mode: 0o600 });
  return {
    snapshotVersion: "GeoNames-CN-admin-places-v2",
    placeCount: snapshot.places.length,
    contentSha256,
    outputDataFile: input.outputDataFile,
    outputManifestModule: input.outputManifestModule,
    sourceFiles
  };
}

const CLI_FLAGS = [
  "--source-directory",
  "--retrieved-at",
  "--output-data-file",
  "--output-manifest-module"
] as const;

type CliFlag = typeof CLI_FLAGS[number];

function parseCliArguments(args: readonly string[]): GeoNamesAdminBuildInput {
  const values = new Map<CliFlag, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!CLI_FLAGS.some((candidate) => candidate === flag)) {
      throw new TypeError(`未知参数: ${flag ?? "<missing>"}`);
    }
    const typedFlag = flag as CliFlag;
    if (values.has(typedFlag)) throw new TypeError(`参数不得重复: ${typedFlag}`);
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new TypeError(`参数缺少值: ${typedFlag}`);
    }
    values.set(typedFlag, value);
  }
  for (const flag of CLI_FLAGS) {
    if (!values.has(flag)) throw new TypeError(`缺少必填参数: ${flag}`);
  }
  return {
    sourceDirectory: values.get("--source-directory")!,
    retrievedAt: values.get("--retrieved-at")!,
    outputDataFile: values.get("--output-data-file")!,
    outputManifestModule: values.get("--output-manifest-module")!
  };
}

export async function runGeoNamesAdminCli(args: readonly string[]): Promise<void> {
  const report = await buildGeoNamesAdminArtifacts(parseCliArguments(args));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runGeoNamesAdminCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "未知错误";
    process.stderr.write(`地点快照生成失败：${message}\n`);
    process.exitCode = 1;
  });
}
