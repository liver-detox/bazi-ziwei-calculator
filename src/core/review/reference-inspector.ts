import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";

import {
  ReferenceSourceV1Schema,
  type ReferenceSourceV1
} from "./contracts/reference-evidence.js";
import { ReviewError } from "./errors.js";
import { deriveEvidenceIdentity } from "./ids.js";

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const EVIDENCE_ID_PATTERN = /^EVD-[0-9a-f]{16}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_TYPES = new Set<ReferenceSourceV1["mediaType"]>([
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/json"
]);
const SOURCE_KINDS = new Set<ReferenceSourceV1["kind"]>([
  "original_text",
  "external_screenshot",
  "manual_panel",
  "legacy_generated"
]);
const SOURCE_LABELS = new Set<ReferenceSourceV1["displayLabel"]>([
  "原始文字资料",
  "外部参考截图",
  "人工核对盘面",
  "历史同源生成物"
]);
const INDEPENDENCE_VALUES = new Set<ReferenceSourceV1["independence"]>([
  "independent",
  "unknown",
  "same_engine_excluded"
]);
const PRIVACY_VALUES = new Set<ReferenceSourceV1["privacy"]>([
  "public_derived",
  "private_local"
]);

export interface InspectReferenceSourceInput {
  sourcePath: string;
  allowedRoots: readonly string[];
  kind: ReferenceSourceV1["kind"];
  displayLabel: ReferenceSourceV1["displayLabel"];
  engine: ReferenceSourceV1["engine"];
  independence: ReferenceSourceV1["independence"];
  privacy: ReferenceSourceV1["privacy"];
}

export interface PrivateSourceLocationV1 {
  schemaVersion: "1.0.0";
  evidenceId: string;
  sourcePath: string;
  contentSha256: string;
  byteLength: number;
  mediaType: ReferenceSourceV1["mediaType"];
}

export interface InspectedReferenceSource {
  publicSource: ReferenceSourceV1;
  privateLocation: PrivateSourceLocationV1;
}

export interface VerifiedReferenceSource {
  evidenceId: string;
  contentSha256: string;
  byteLength: number;
  mediaType: ReferenceSourceV1["mediaType"];
  bytes: Buffer;
}

interface StableFile {
  bytes: Buffer;
  byteLength: number;
  contentSha256: string;
  mediaType: ReferenceSourceV1["mediaType"];
}

function reviewError(
  code: string,
  message: string,
  statusCode: 404 | 409 | 413 | 415 | 422
): ReviewError {
  return new ReviewError(code, message, statusCode);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function assertInspectInput(value: unknown): asserts value is InspectReferenceSourceInput {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, [
      "sourcePath",
      "allowedRoots",
      "kind",
      "displayLabel",
      "engine",
      "independence",
      "privacy"
    ])
  ) {
    throw reviewError("SOURCE_INPUT_INVALID", "参考来源检查输入无效", 422);
  }
  const input = value as Record<string, unknown>;
  const engine = input.engine;
  const validEngine = engine === null || (
    typeof engine === "object"
    && !Array.isArray(engine)
    && exactKeys(engine, ["name", "version"])
    && typeof (engine as Record<string, unknown>).name === "string"
    && (engine as Record<string, string>).name.length > 0
    && typeof (engine as Record<string, unknown>).version === "string"
    && (engine as Record<string, string>).version.length > 0
  );
  if (
    typeof input.sourcePath !== "string"
    || !Array.isArray(input.allowedRoots)
    || !input.allowedRoots.every((root) => typeof root === "string")
    || !SOURCE_KINDS.has(input.kind as ReferenceSourceV1["kind"])
    || !SOURCE_LABELS.has(input.displayLabel as ReferenceSourceV1["displayLabel"])
    || !validEngine
    || !INDEPENDENCE_VALUES.has(input.independence as ReferenceSourceV1["independence"])
    || !PRIVACY_VALUES.has(input.privacy as ReferenceSourceV1["privacy"])
  ) {
    throw reviewError("SOURCE_INPUT_INVALID", "参考来源检查输入无效", 422);
  }
}

function assertAbsoluteSafePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw reviewError("SOURCE_PATH_INVALID", "参考来源路径无效", 422);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const boundary = relative(root, candidate);
  return boundary === "" || (
    boundary !== ".."
    && !boundary.startsWith(`..${sep}`)
    && !isAbsolute(boundary)
  );
}

async function resolveAllowedSource(sourcePath: string, allowedRoots: readonly string[]): Promise<string> {
  assertAbsoluteSafePath(sourcePath);
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw reviewError("SOURCE_PATH_INVALID", "批准来源根目录不能为空", 422);
  }

  const resolvedRoots: string[] = [];
  for (const root of allowedRoots) {
    assertAbsoluteSafePath(root);
    try {
      resolvedRoots.push(await realpath(root));
    } catch {
      throw reviewError("SOURCE_PATH_INVALID", "批准来源根目录无效", 422);
    }
  }

  let resolvedSource: string;
  try {
    resolvedSource = await realpath(sourcePath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw reviewError("SOURCE_NOT_FOUND", "参考来源不存在", 404);
    }
    throw reviewError("SOURCE_PATH_INVALID", "参考来源路径无效", 422);
  }
  if (!resolvedRoots.some((root) => isWithinRoot(resolvedSource, root))) {
    throw reviewError("SOURCE_PATH_INVALID", "参考来源不在批准目录内", 422);
  }
  return resolvedSource;
}

async function assertOriginalFinalRegular(sourcePath: string): Promise<void> {
  try {
    const originalFinal = await lstat(sourcePath);
    if (originalFinal.isSymbolicLink() || !originalFinal.isFile()) {
      throw reviewError("SOURCE_TYPE_INVALID", "参考来源必须是普通文件且不能是符号链接", 422);
    }
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw reviewError("SOURCE_CHANGED", "参考来源在检查期间发生变化", 409);
    }
    throw reviewError("SOURCE_PATH_INVALID", "参考来源路径无效", 422);
  }
}

function assertPublicMetadataRedacted(
  engine: ReferenceSourceV1["engine"],
  canonicalSourcePath: string
): void {
  const denied = [canonicalSourcePath, basename(canonicalSourcePath)];
  if (
    engine !== null
    && [engine.name, engine.version].some((value) => denied.some((secret) => value.includes(secret)))
  ) {
    throw reviewError("SOURCE_PRIVACY_VIOLATION", "公开参考来源元数据包含私密来源信息", 422);
  }
}

function sameLockedEngine(engine: ReferenceSourceV1["engine"]): boolean {
  return (
    engine?.name === "iztro" && engine.version === "2.5.8"
  ) || (
    engine?.name === "lunar-typescript" && engine.version === "1.8.6"
  );
}

function normalizedIndependence(
  engine: ReferenceSourceV1["engine"],
  independence: ReferenceSourceV1["independence"]
): ReferenceSourceV1["independence"] {
  return sameLockedEngine(engine) && independence !== "independent"
    ? "same_engine_excluded"
    : independence;
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint; size: number | bigint },
  right: { dev: number | bigint; ino: number | bigint; size: number | bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function detectMediaType(bytes: Buffer): ReferenceSourceV1["mediaType"] {
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw reviewError("SOURCE_MEDIA_UNSUPPORTED", "参考来源媒体类型不受支持", 415);
  }
  for (const character of text) {
    const codePoint = character.codePointAt(0) as number;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || codePoint === 0x7f
      || (codePoint >= 0x80 && codePoint <= 0x9f)
    ) {
      throw reviewError("SOURCE_MEDIA_UNSUPPORTED", "参考来源媒体类型不受支持", 415);
    }
  }

  const trimmed = text.trim();
  if (trimmed !== "") {
    try {
      JSON.parse(trimmed);
      return "application/json";
    } catch {
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        throw reviewError("SOURCE_MEDIA_UNSUPPORTED", "参考来源媒体类型不受支持", 415);
      }
    }
  }
  return "text/plain";
}

async function readDescriptor(handle: FileHandle): Promise<{ bytes: Buffer; contentSha256: string }> {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let byteLength = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(chunk, 0, chunk.length, null));
    } catch {
      throw reviewError("SOURCE_CHANGED", "参考来源在读取期间发生变化", 409);
    }
    if (bytesRead === 0) break;
    byteLength += bytesRead;
    if (byteLength > MAX_REFERENCE_BYTES) {
      throw reviewError("SOURCE_OVERSIZED", "参考来源超过 10 MiB 限制", 413);
    }
    const bytes = chunk.subarray(0, bytesRead);
    chunks.push(bytes);
    hash.update(bytes);
  }
  return {
    bytes: Buffer.concat(chunks, byteLength),
    contentSha256: `sha256:${hash.digest("hex")}`
  };
}

async function stableRead(sourcePath: string, missingAfterResolution = false): Promise<StableFile> {
  let beforeOpen;
  try {
    beforeOpen = await lstat(sourcePath);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw missingAfterResolution
        ? reviewError("SOURCE_CHANGED", "参考来源在检查期间发生变化", 409)
        : reviewError("SOURCE_NOT_FOUND", "参考来源不存在", 404);
    }
    throw reviewError("SOURCE_PATH_INVALID", "参考来源路径无效", 422);
  }
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw reviewError("SOURCE_TYPE_INVALID", "参考来源必须是普通文件且不能是符号链接", 422);
  }
  if (beforeOpen.size > MAX_REFERENCE_BYTES) {
    throw reviewError("SOURCE_OVERSIZED", "参考来源超过 10 MiB 限制", 413);
  }

  let handle: FileHandle;
  try {
    handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) {
      throw reviewError("SOURCE_CHANGED", "参考来源在检查期间发生变化", 409);
    }
    throw reviewError("SOURCE_PATH_INVALID", "无法安全打开参考来源", 422);
  }

  try {
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      throw reviewError("SOURCE_CHANGED", "参考来源在检查期间发生变化", 409);
    }
    if (!sameFileIdentity(beforeOpen, opened)) {
      throw reviewError("SOURCE_CHANGED", "参考来源在检查期间发生变化", 409);
    }

    const read = await readDescriptor(handle);
    let mediaType: ReferenceSourceV1["mediaType"] | undefined;
    let mediaError: ReviewError | undefined;
    try {
      mediaType = detectMediaType(read.bytes);
    } catch (error) {
      if (error instanceof ReviewError) mediaError = error;
      else throw error;
    }

    let afterRead;
    try {
      afterRead = await handle.stat();
    } catch {
      throw reviewError("SOURCE_CHANGED", "参考来源在读取期间发生变化", 409);
    }
    if (!sameFileIdentity(opened, afterRead) || afterRead.size !== read.bytes.length) {
      throw reviewError("SOURCE_CHANGED", "参考来源在读取期间发生变化", 409);
    }
    if (mediaError !== undefined) throw mediaError;
    if (mediaType === undefined) {
      throw reviewError("SOURCE_MEDIA_UNSUPPORTED", "参考来源媒体类型不受支持", 415);
    }
    return {
      ...read,
      byteLength: read.bytes.length,
      mediaType
    };
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing is always attempted; a close failure must not expose a platform path.
    }
  }
}

function assertPrivateLocation(location: PrivateSourceLocationV1): void {
  if (location === null || typeof location !== "object" || Array.isArray(location)) {
    throw reviewError("SOURCE_LOCATION_INVALID", "私密来源位置记录无效", 422);
  }
  const keys = Object.keys(location).sort();
  const expectedKeys = [
    "byteLength",
    "contentSha256",
    "evidenceId",
    "mediaType",
    "schemaVersion",
    "sourcePath"
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || location.schemaVersion !== "1.0.0"
    || !EVIDENCE_ID_PATTERN.test(location.evidenceId)
    || !SHA256_PATTERN.test(location.contentSha256)
    || !Number.isSafeInteger(location.byteLength)
    || location.byteLength < 0
    || !MEDIA_TYPES.has(location.mediaType)
  ) {
    throw reviewError("SOURCE_LOCATION_INVALID", "私密来源位置记录无效", 422);
  }
  assertAbsoluteSafePath(location.sourcePath);
}

export async function inspectReferenceSource(
  input: InspectReferenceSourceInput
): Promise<InspectedReferenceSource> {
  assertInspectInput(input);
  const resolvedSource = await resolveAllowedSource(input.sourcePath, input.allowedRoots);
  assertPublicMetadataRedacted(input.engine, resolvedSource);
  await assertOriginalFinalRegular(input.sourcePath);
  const inspected = await stableRead(resolvedSource, true);
  const sourceBody = {
    kind: input.kind,
    contentSha256: inspected.contentSha256,
    byteLength: inspected.byteLength,
    displayLabel: input.displayLabel,
    mediaType: inspected.mediaType,
    engine: input.engine,
    independence: normalizedIndependence(input.engine, input.independence),
    privacy: input.privacy
  };
  const identity = deriveEvidenceIdentity(sourceBody);
  const parsed = ReferenceSourceV1Schema.safeParse({
    evidenceId: identity.id,
    evidenceFingerprint: identity.fingerprint,
    ...sourceBody
  });
  if (!parsed.success) {
    throw reviewError("SOURCE_SEMANTIC_INVALID", "参考来源语义元数据无效", 422);
  }
  return {
    publicSource: parsed.data,
    privateLocation: {
      schemaVersion: "1.0.0",
      evidenceId: parsed.data.evidenceId,
      sourcePath: resolvedSource,
      contentSha256: parsed.data.contentSha256,
      byteLength: parsed.data.byteLength,
      mediaType: parsed.data.mediaType
    }
  };
}

export async function verifyReferenceSource(
  location: PrivateSourceLocationV1
): Promise<VerifiedReferenceSource> {
  assertPrivateLocation(location);
  const inspected = await stableRead(location.sourcePath);
  if (
    inspected.contentSha256 !== location.contentSha256
    || inspected.byteLength !== location.byteLength
    || inspected.mediaType !== location.mediaType
  ) {
    throw reviewError("SOURCE_CHANGED", "参考来源内容与已授权记录不一致", 409);
  }
  return {
    evidenceId: location.evidenceId,
    contentSha256: inspected.contentSha256,
    byteLength: inspected.byteLength,
    mediaType: inspected.mediaType,
    bytes: inspected.bytes
  };
}
