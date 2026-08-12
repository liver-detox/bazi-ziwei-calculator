import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

export const MAX_ARCHIVE_FILES = 256;
export const MAX_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 32 * 1024 * 1024;

export interface EvidenceArchiveEntry {
  path: string;
  bytes: Buffer;
}

export class EvidenceArchiveError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "EvidenceArchiveError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: string, message: string, detail?: string): never {
  throw new EvidenceArchiveError(code, message, detail);
}

function assertSafePath(path: string): void {
  const normalized = posix.normalize(path);
  if (
    path === ""
    || path !== normalized
    || path.startsWith("/")
    || path.includes("\\")
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    fail("UNSAFE_ARCHIVE_PATH", "证据包包含不安全的文件路径", path);
  }
  if (Buffer.byteLength(path, "utf8") > 100) {
    fail("ARCHIVE_PATH_TOO_LONG", "证据包文件名超过安全长度上限", path);
  }
}

function normalizedEntries(entries: readonly EvidenceArchiveEntry[]): EvidenceArchiveEntry[] {
  if (entries.length > MAX_ARCHIVE_FILES) {
    fail("ARCHIVE_FILE_LIMIT", "证据包文件数量超过上限");
  }
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"));
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const entry of sorted) {
    assertSafePath(entry.path);
    if (entry.path === previousPath) {
      fail("DUPLICATE_ARCHIVE_PATH", "证据包包含重复文件名", entry.path);
    }
    previousPath = entry.path;
    if (entry.bytes.byteLength > MAX_ARCHIVE_FILE_BYTES) {
      fail("ARCHIVE_FILE_TOO_LARGE", "证据包中的单个文件超过上限", entry.path);
    }
    totalBytes += entry.bytes.byteLength;
    if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      fail("ARCHIVE_TOTAL_TOO_LARGE", "证据包总大小超过上限");
    }
  }
  return sorted;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) {
    fail("ARCHIVE_VALUE_TOO_LARGE", "证据包文件信息超过 tar 格式上限");
  }
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(entry: EvidenceArchiveEntry): Buffer {
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function buildEvidenceTarGzip(entries: readonly EvidenceArchiveEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of normalizedEntries(entries)) {
    blocks.push(tarHeader(entry), entry.bytes);
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export async function archiveEvidenceDirectory(directory: string): Promise<Buffer> {
  const rootStatus = await lstat(directory);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    fail("NON_FILE_ARCHIVE_ENTRY", "证据包来源不是安全目录", directory);
  }
  const diskEntries = await readdir(directory, { recursive: true, withFileTypes: true });
  const directories: string[] = [];
  const files: Array<{ path: string; absolutePath: string; byteLength: number }> = [];
  for (const entry of diskEntries) {
    const absolutePath = join(entry.parentPath, entry.name);
    const path = relative(directory, absolutePath).split(sep).join("/");
    assertSafePath(path);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink()) {
      fail("NON_FILE_ARCHIVE_ENTRY", "证据包拒绝符号链接或其他非普通文件", path);
    }
    if (status.isDirectory()) {
      directories.push(path);
      continue;
    }
    if (!status.isFile()) {
      fail("NON_FILE_ARCHIVE_ENTRY", "证据包拒绝非普通文件", path);
    }
    files.push({ path, absolutePath, byteLength: status.size });
  }
  for (const directoryPath of directories) {
    if (!files.some((file) => file.path.startsWith(`${directoryPath}/`))) {
      fail("NON_FILE_ARCHIVE_ENTRY", "证据包拒绝空目录或非文件条目", directoryPath);
    }
  }
  if (files.length > MAX_ARCHIVE_FILES) {
    fail("ARCHIVE_FILE_LIMIT", "证据包文件数量超过上限");
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.byteLength > MAX_ARCHIVE_FILE_BYTES) {
      fail("ARCHIVE_FILE_TOO_LARGE", "证据包中的单个文件超过上限", file.path);
    }
    totalBytes += file.byteLength;
    if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      fail("ARCHIVE_TOTAL_TOO_LARGE", "证据包总大小超过上限");
    }
  }
  const entries: EvidenceArchiveEntry[] = [];
  for (const file of files) {
    let handle;
    try {
      handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const status = await handle.stat();
      if (!status.isFile() || status.size !== file.byteLength) {
        fail("NON_FILE_ARCHIVE_ENTRY", "证据包文件在读取期间发生变化", file.path);
      }
      entries.push({ path: file.path, bytes: await handle.readFile() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        fail("NON_FILE_ARCHIVE_ENTRY", "证据包拒绝符号链接", file.path);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
  return buildEvidenceTarGzip(entries);
}
