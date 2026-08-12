import { readFile } from "node:fs/promises";

import { BirthRecordV1Schema, type BirthRecordV1 } from "../../shared/contracts.js";
import { sha256Bytes } from "../storage/canonical.js";
import { CaseStore, type LegacySourceRecord } from "../storage/case-store.js";

const MAX_LEGACY_BYTES = 5 * 1024 * 1024;

export class LegacyImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyImportError";
    this.code = code;
  }
}

export interface LegacyBirthRecordPreview {
  selector: string;
  record: Omit<BirthRecordV1, "privateName">;
  hasPrivateIdentity: boolean;
}

export interface LegacyInspection {
  source: LegacySourceRecord;
  format: "json" | "opaque";
  compatibleRecords: LegacyBirthRecordPreview[];
  note: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function candidateValues(value: unknown): Array<{ selector: string; value: unknown }> {
  const candidates: Array<{ selector: string; value: unknown }> = [{ selector: "root", value }];
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item, index) => candidates.push({ selector: `root/${index}`, value: item }));
    return candidates;
  }
  if (!isObject(value)) return candidates;

  ["birthRecord", "input"].forEach((key) => {
    if (key in value) candidates.push({ selector: key, value: value[key] });
  });
  if (Array.isArray(value.records)) {
    value.records.slice(0, 100).forEach((item, index) => candidates.push({ selector: `records/${index}`, value: item }));
  }
  return candidates;
}

function compatibleRecords(value: unknown): Array<{ selector: string; record: BirthRecordV1 }> {
  const records: Array<{ selector: string; record: BirthRecordV1 }> = [];
  for (const candidate of candidateValues(value)) {
    const parsed = BirthRecordV1Schema.safeParse(candidate.value);
    if (parsed.success) records.push({ selector: candidate.selector, record: parsed.data });
  }
  return records;
}

async function readBoundedJson(source: LegacySourceRecord): Promise<unknown> {
  if (source.byteLength > MAX_LEGACY_BYTES) {
    throw new LegacyImportError("LEGACY_SOURCE_TOO_LARGE", "旧案文件超过 5 MiB，只能记录来源而不能解析导入");
  }
  const bytes = await readFile(source.sourcePath);
  if (`sha256:${sha256Bytes(bytes)}` !== source.sha256) {
    throw new LegacyImportError("LEGACY_SOURCE_CHANGED", "旧案文件在读取期间发生变化，请重新检查");
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new LegacyImportError("LEGACY_SOURCE_NOT_JSON", "旧案文件不是可选择导入的 JSON；仍可作为来源证据关联", { cause: error });
  }
}

export async function inspectLegacyBirthRecords(
  store: CaseStore,
  sourcePath: string
): Promise<LegacyInspection> {
  const source = await store.inspectLegacySource(sourcePath);
  try {
    const parsed = await readBoundedJson(source);
    return {
      source,
      format: "json",
      compatibleRecords: compatibleRecords(parsed).map(({ selector, record }) => {
        const { privateName: _privateName, ...publicRecord } = record;
        return { selector, record: publicRecord, hasPrivateIdentity: _privateName !== undefined };
      }),
      note: "只读取并校验该文件；原文件不会被改写。"
    };
  } catch (error) {
    if (error instanceof LegacyImportError && error.code === "LEGACY_SOURCE_NOT_JSON") {
      return {
        source,
        format: "opaque",
        compatibleRecords: [],
        note: error.message
      };
    }
    throw error;
  }
}

export async function loadSelectedLegacyBirthRecord(
  store: CaseStore,
  input: { sourcePath: string; expectedSha256: string; selector: string }
): Promise<{ record: BirthRecordV1; source: LegacySourceRecord }> {
  const source = await store.inspectLegacySource(input.sourcePath);
  if (source.sha256 !== input.expectedSha256) {
    throw new LegacyImportError("LEGACY_SOURCE_CHANGED", "旧案文件指纹与检查时不同，已停止导入");
  }
  const parsed = await readBoundedJson(source);
  const selected = compatibleRecords(parsed).find((candidate) => candidate.selector === input.selector);
  if (selected === undefined) {
    throw new LegacyImportError("LEGACY_SELECTOR_INVALID", "所选旧案记录不存在或不符合 BirthRecordV1");
  }
  return { record: selected.record, source };
}
