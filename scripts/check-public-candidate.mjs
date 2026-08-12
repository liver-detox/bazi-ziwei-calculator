import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, parse, posix, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

const manifestRelativePath = "release/public-files.json";
const generatedRoots = new Set(["node_modules", "dist"]);
const forbiddenRootSegments = new Set([
  ".git", "data", "output", "exports", "artifacts", ".superpowers", ".worktrees",
  ".playwright-cli", "coverage", "test-results", "playwright-report", "node_modules", "dist",
  "screenshots", "tmp", "temp"
]);
const forbiddenSegmentsAnywhere = new Set([".git", "cases", "revisions", "private"]);
const forbiddenSuffixes = [
  ".pem", ".key", ".p12", ".db", ".sqlite", ".sqlite3", ".log",
  ".tar", ".tar.gz", ".tgz", ".zip"
];
const imageName = /^docs\/images\/demo-[a-z0-9-]+\.png$/u;
const imageSuffix = /\.(?:png|jpg|jpeg)$/iu;

function fail(code, path) {
  process.stdout.write(`PUBLIC_CHECK_FAILED ${code} ${path}\n`);
  process.exit(1);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasSafePathSyntax(path) {
  return typeof path === "string"
    && path.length > 0
    && path === path.normalize("NFC")
    && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
    && !isAbsolute(path)
    && !posix.isAbsolute(path)
    && !/^[A-Za-z]:/u.test(path)
    && !path.endsWith("/")
    && posix.normalize(path) === path
    && !path.split("/").some((segment) => segment === "." || segment === "..");
}

function isForbiddenManifestPath(path) {
  const segments = path.split("/");
  return forbiddenRootSegments.has(segments[0])
    || segments.some((segment) => forbiddenSegmentsAnywhere.has(segment))
    || forbiddenSuffixes.some((suffix) => path.toLowerCase().endsWith(suffix))
    || segments.some((segment) => segment === ".env" || segment.startsWith(".env."));
}

function parseRoot() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--root" || args[1].length === 0) {
    fail("invalid-arguments", "candidate");
  }
  return resolve(args[1]);
}

async function requireRoot(root) {
  try {
    const parsed = parse(root);
    let current = parsed.root;
    for (const segment of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      const segmentStatus = await lstat(current);
      if (segmentStatus.isSymbolicLink()) throw new Error("symlinked root segment");
    }
    const status = await lstat(root);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(root) !== root) {
      fail("root-invalid", "candidate");
    }
    return root;
  } catch {
    fail("root-invalid", "candidate");
  }
}

function isContained(root, candidate, allowRoot = false) {
  const relation = relative(root, candidate);
  return (allowRoot || relation.length > 0)
    && relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
}

function containedPath(root, relativePath) {
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!isContained(root, candidate)) throw new Error("path escape");
  return candidate;
}

function sameIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

async function validateDirectoryChain(root, directory) {
  if (!isContained(root, directory, true)) throw new Error("directory escape");
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("unsafe root");
  }
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error("unsafe directory");
    }
  }
}

async function openVerifiedRegular(root, relativePath) {
  const absolute = containedPath(root, relativePath);
  await validateDirectoryChain(root, dirname(absolute));
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("non-regular file");
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolute, constants.O_RDONLY | noFollow);
  try {
    const after = await handle.stat();
    if (!after.isFile() || !sameIdentity(before, after)) throw new Error("replaced file");
    await validateDirectoryChain(root, dirname(absolute));
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function validateManifestBytes(bytes) {
  let manifest;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    manifest = JSON.parse(text);
  } catch {
    fail("manifest-invalid", manifestRelativePath);
  }
  if (!hasExactKeys(manifest, ["schemaVersion", "files"])
    || manifest.schemaVersion !== "1.0.0"
    || !Array.isArray(manifest.files)
    || new Set(manifest.files).size !== manifest.files.length
    || manifest.files.some((path, index) => !hasSafePathSyntax(path)
      || (index > 0 && manifest.files[index - 1] >= path))
    || !manifest.files.includes(manifestRelativePath)) {
    fail("manifest-invalid", manifestRelativePath);
  }
  for (const path of manifest.files) {
    if (isForbiddenManifestPath(path)) fail("manifest-forbidden", path);
  }
  return manifest;
}

async function loadManifest(root) {
  let handle;
  let bytes;
  try {
    handle = await openVerifiedRegular(root, manifestRelativePath);
    bytes = await handle.readFile();
  } catch {
    fail("manifest-invalid", manifestRelativePath);
  } finally {
    await handle?.close().catch(() => {});
  }
  return validateManifestBytes(bytes);
}

function splitNullRecords(bytes) {
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index > start) records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) fail("git-inventory", "git-index");
  return records;
}

function parseIndexRecord(record) {
  const tab = record.indexOf(0x09);
  if (tab <= 0 || tab === record.length - 1) fail("git-inventory", "git-index");
  const header = record.subarray(0, tab).toString("ascii");
  const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(header);
  if (match === null) fail("git-inventory", "git-index");
  let path;
  try {
    path = new TextDecoder("utf-8", { fatal: true }).decode(record.subarray(tab + 1));
  } catch {
    fail("path-invalid", "git-index");
  }
  if (!hasSafePathSyntax(path)) fail("path-invalid", "git-index");
  if (match[3] !== "0") fail("git-inventory", "git-index");
  if (match[1] !== "100644" && match[1] !== "100755") fail("file-mode", path);
  return { mode: match[1], hash: match[2], path };
}

async function gitIndex(root) {
  const gitPath = resolve(root, ".git");
  try {
    const status = await lstat(gitPath);
    if (!status.isDirectory() || status.isSymbolicLink()) fail("file-type", ".git");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("file-type", ".git");
  }

  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (await realpath(topLevel) !== await realpath(root)) fail("git-inventory", "git-index");
    const output = execFileSync("git", ["ls-files", "--stage", "-z"], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024
    });
    const entries = splitNullRecords(output).map(parseIndexRecord);
    if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
      fail("git-inventory", "git-index");
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  } catch {
    fail("git-inventory", "git-index");
  }
}

function readIndexBlob(root, hash, path) {
  try {
    return execFileSync("git", ["cat-file", "blob", hash], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    fail("file-read", path);
  }
}

async function preGitInventory(root, prefix = "") {
  const files = [];
  let entries;
  const directory = prefix.length === 0 ? root : containedPath(root, prefix);
  try {
    await validateDirectoryChain(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    fail("inventory", "candidate");
  }
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (!hasSafePathSyntax(relativePath)) fail("path-invalid", "candidate");
    if (prefix.length === 0 && generatedRoots.has(entry.name)) {
      const status = await lstat(containedPath(root, entry.name));
      if (status.isDirectory() && !status.isSymbolicLink()) continue;
      fail("file-type", relativePath);
    }
    if (entry.isSymbolicLink()) fail("file-type", relativePath);
    if (entry.isDirectory()) files.push(...await preGitInventory(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else fail("file-type", relativePath);
  }
  return files.sort();
}

function compareInventory(actual, expected) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const difference = [...actual.filter((path) => !expectedSet.has(path)),
    ...expected.filter((path) => !actualSet.has(path))].sort()[0];
  if (difference !== undefined) fail("file-set", difference);
}

function contentRisk(text) {
  const privateKeyTypes = [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "DSA PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK"
  ];
  const privateKeyHeaders = privateKeyTypes.map((type) => ["-----BEGIN ", type, "-----"].join(""));
  if (privateKeyHeaders.some((header) => text.includes(header))) return "content-private-key";
  const githubPrefixes = ["p", "o", "u", "s", "r"]
    .map((kind) => ["gh", kind, "_"].join(""));
  const tokenPatterns = [
    ...githubPrefixes.map((prefix) => new RegExp(`${prefix}[A-Za-z0-9]{20,}`, "u")),
    new RegExp(`${["github", "_pat_"].join("")}[A-Za-z0-9_]{20,}`, "u"),
    new RegExp(`${["sk", "-"].join("")}(?:proj-)?[A-Za-z0-9_-]{20,}`, "u"),
    new RegExp(`${["gl", "pat-"].join("")}[A-Za-z0-9_-]{20,}`, "u"),
    new RegExp(`${["xox", "b-"].join("")}[A-Za-z0-9-]{30,}`, "u"),
    new RegExp(`${["xox", "p-"].join("")}[A-Za-z0-9-]{30,}`, "u"),
    new RegExp(`${["AK", "IA"].join("")}[0-9A-Z]{16}`, "u"),
    new RegExp(`${["AS", "IA"].join("")}[0-9A-Z]{16}`, "u"),
    new RegExp(`${["AI", "za"].join("")}[A-Za-z0-9_-]{30,}`, "u")
  ];
  if (tokenPatterns.some((pattern) => pattern.test(text))) return "content-token";
  const userRoots = [
    ["/", "Users", "/"].join(""),
    ["/", "home", "/"].join(""),
    ["/", "root", "/"].join(""),
    ["C:", "/", "Users", "/"].join(""),
    ["C:", "\\", "Users", "\\"].join("")
  ];
  if (userRoots.some((prefix) => text.includes(prefix))) return "content-user-root";
  return null;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isMetadataFreePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < signature.length || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bytesPerPixel = 0;
  let state = "header";
  const compressed = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    const expectedCrc = bytes.readUInt32BE(dataStart + length);
    if (crc32(Buffer.concat([typeBytes, data])) !== expectedCrc) return false;

    if (state === "header") {
      if (type !== "IHDR" || length !== 13) return false;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (width === 0 || height === 0 || width > 10_000 || height > 10_000
        || width * height > 50_000_000 || bitDepth !== 8
        || ![2, 6].includes(colorType) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        return false;
      }
      bytesPerPixel = colorType === 6 ? 4 : 3;
      state = "data";
    } else if (state === "data" && type === "IDAT") {
      compressed.push(data);
    } else if (state === "data" && type === "IEND") {
      if (length !== 0 || compressed.length === 0) return false;
      state = "end";
    } else {
      // Metadata-free policy: reject every ancillary and unneeded critical chunk.
      return false;
    }
    offset += 12 + length;
    if (state === "end") break;
  }
  if (state !== "end" || offset !== bytes.length) return false;

  const rowLength = 1 + width * bytesPerPixel;
  const expectedLength = rowLength * height;
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedLength });
  } catch {
    return false;
  }
  if (pixels.length !== expectedLength) return false;
  for (let row = 0; row < height; row += 1) {
    if (pixels[row * rowLength] > 4) return false;
  }
  return true;
}

function scanImage(bytes, path) {
  if (!imageName.test(path)) fail("image-name", path);
  let safe;
  try {
    safe = isMetadataFreePng(bytes);
  } catch {
    fail("image-metadata", path);
  }
  if (!safe) fail("image-metadata", path);
}

function scanBytes(bytes, path) {
  if (imageSuffix.test(path)) {
    scanImage(bytes, path);
    return;
  }
  if (bytes.includes(0)) fail("content-binary", path);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("content-binary", path);
  }
  const risk = contentRisk(text);
  if (risk !== null) fail(risk, path);
}

async function scanFile(root, path) {
  let handle;
  try {
    handle = await openVerifiedRegular(root, path);
  } catch {
    fail("file-type", path);
  }
  let bytes;
  try {
    bytes = await handle.readFile();
  } catch {
    fail("file-read", path);
  } finally {
    await handle?.close().catch(() => {});
  }
  scanBytes(bytes, path);
}

const root = await requireRoot(parseRoot());
const index = await gitIndex(root);
if (index === null) {
  const manifest = await loadManifest(root);
  const inventory = await preGitInventory(root);
  compareInventory(inventory, manifest.files);
  for (const path of manifest.files) await scanFile(root, path);
} else {
  const manifestEntry = index.find(({ path }) => path === manifestRelativePath);
  if (manifestEntry === undefined) fail("file-set", manifestRelativePath);
  const manifest = validateManifestBytes(readIndexBlob(root, manifestEntry.hash, manifestEntry.path));
  compareInventory(index.map(({ path }) => path), manifest.files);
  for (const entry of index) scanBytes(readIndexBlob(root, entry.hash, entry.path), entry.path);
}
