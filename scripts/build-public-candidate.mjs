import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  readdir
} from "node:fs/promises";
import { dirname, isAbsolute, parse, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestRelativePath = "release/public-files.json";
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

function fail(code, path = manifestRelativePath) {
  process.stdout.write(`PUBLIC_BUILD_FAILED ${code} ${path}\n`);
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

function isSafeRelativePath(path) {
  const segments = typeof path === "string" ? path.split("/") : [];
  return typeof path === "string"
    && path.length > 0
    && path === path.normalize("NFC")
    && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
    && !isAbsolute(path)
    && !posix.isAbsolute(path)
    && !/^[A-Za-z]:/u.test(path)
    && !path.endsWith("/")
    && posix.normalize(path) === path
    && !segments.some((segment) => segment === "." || segment === "..")
    && !forbiddenRootSegments.has(segments[0])
    && !segments.some((segment) => forbiddenSegmentsAnywhere.has(segment))
    && !forbiddenSuffixes.some((suffix) => path.toLowerCase().endsWith(suffix))
    && !segments.some((segment) => segment === ".env" || segment.startsWith(".env."));
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

async function requireNoSymlinkAbsolutePath(path, allowMissingTail) {
  const parsed = parse(path);
  const segments = path.slice(parsed.root.length).split(sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;
  for (const segment of segments) {
    current = resolve(current, segment);
    if (missing) continue;
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) throw new Error("symlinked path");
    } catch (error) {
      if (allowMissingTail && error?.code === "ENOENT") {
        missing = true;
        continue;
      }
      throw error;
    }
  }
}

async function canonicalExistingRoot(root) {
  await requireNoSymlinkAbsolutePath(root, false);
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("invalid root");
  const canonical = await realpath(root);
  if (canonical !== root) throw new Error("aliased root");
  return canonical;
}

async function validateDirectoryChain(root, directory) {
  if (!isContained(root, directory, true)) throw new Error("directory escape");
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error("unsafe root");
  }
  const relation = relative(root, directory);
  let current = root;
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe directory");
    if (await realpath(current) !== current) throw new Error("aliased directory");
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
    return { handle, status: after };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readManifest(sourceRoot) {
  let manifest;
  let opened;
  try {
    opened = await openVerifiedRegular(sourceRoot, manifestRelativePath);
    manifest = JSON.parse(await opened.handle.readFile({ encoding: "utf8" }));
  } catch {
    fail("invalid-manifest");
  } finally {
    await opened?.handle.close().catch(() => {});
  }
  if (!hasExactKeys(manifest, ["schemaVersion", "files"])
    || manifest.schemaVersion !== "1.0.0"
    || !Array.isArray(manifest.files)
    || manifest.files.some((path) => !isSafeRelativePath(path))
    || new Set(manifest.files).size !== manifest.files.length
    || manifest.files.some((path, index) => index > 0 && manifest.files[index - 1] >= path)
    || !manifest.files.includes(manifestRelativePath)) {
    fail("invalid-manifest");
  }
  return manifest;
}

function parseDestination() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--destination" || args[1].length === 0) {
    fail("invalid-arguments", "destination");
  }
  const destination = resolve(args[1]);
  return destination;
}

function pathsOverlap(left, right) {
  return isContained(left, right, true) || isContained(right, left, true);
}

async function prepareDestination(destination, sourceRoot) {
  try {
    await requireNoSymlinkAbsolutePath(destination, true);
    const parsed = parse(destination);
    const segments = destination.slice(parsed.root.length).split(sep).filter(Boolean);
    let current = parsed.root;
    let firstMissing = -1;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]);
      try {
        const status = await lstat(current);
        if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("unsafe destination");
        if (await realpath(current) !== current) throw new Error("aliased destination");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        firstMissing = index;
        break;
      }
    }

    const existing = firstMissing < 0 ? destination : resolve(
      parsed.root,
      ...segments.slice(0, firstMissing)
    );
    const canonicalExisting = await realpath(existing);
    const prospective = firstMissing < 0 ? canonicalExisting : resolve(
      canonicalExisting,
      ...segments.slice(firstMissing)
    );
    if (pathsOverlap(sourceRoot, prospective)) throw new Error("source overlap");

    if (firstMissing >= 0) {
      current = existing;
      for (const segment of segments.slice(firstMissing)) {
        current = resolve(current, segment);
        await mkdir(current);
        const status = await lstat(current);
        if (!status.isDirectory() || status.isSymbolicLink() || await realpath(current) !== current) {
          throw new Error("unsafe created directory");
        }
      }
    } else if ((await readdir(destination)).length > 0) {
      fail("nonempty-destination", "destination");
    }
    const canonicalDestination = await realpath(destination);
    if (canonicalDestination !== destination || pathsOverlap(sourceRoot, canonicalDestination)) {
      throw new Error("destination alias or overlap");
    }
    return canonicalDestination;
  } catch {
    fail("invalid-destination", "destination");
  }
}

async function ensureTargetParent(destination, relativePath) {
  const target = containedPath(destination, relativePath);
  const parent = dirname(target);
  const relation = relative(destination, parent);
  let current = destination;
  await validateDirectoryChain(destination, destination);
  for (const segment of relation.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink() || await realpath(current) !== current) {
      throw new Error("unsafe target parent");
    }
    if (!isContained(destination, current, true)) throw new Error("target parent escape");
  }
  return { parent, target };
}

async function copyManifestFile(relativePath, sourceRoot, destination) {
  let sourceOpened;
  let targetHandle;
  try {
    sourceOpened = await openVerifiedRegular(sourceRoot, relativePath);
  } catch {
    fail("unsafe-source", relativePath);
  }
  try {
    const { parent, target } = await ensureTargetParent(destination, relativePath);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    targetHandle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      sourceOpened.status.mode & 0o777
    );
    const targetStatus = await targetHandle.stat();
    if (!targetStatus.isFile()) throw new Error("non-regular target");
    if (await realpath(parent) !== parent || !isContained(destination, parent, true)) {
      throw new Error("replaced target parent");
    }
    const bytes = await sourceOpened.handle.readFile();
    await targetHandle.writeFile(bytes);
    await targetHandle.chmod(sourceOpened.status.mode & 0o777);
  } catch {
    fail("copy-failed", relativePath);
  } finally {
    await targetHandle?.close().catch(() => {});
    await sourceOpened?.handle.close().catch(() => {});
  }
}

async function collectCandidateFiles(root, prefix = "") {
  const files = [];
  const directory = prefix.length === 0 ? root : containedPath(root, prefix);
  await validateDirectoryChain(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (!isSafeRelativePath(relativePath)) fail("candidate-mismatch", "candidate");
    if (entry.isDirectory()) files.push(...await collectCandidateFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else fail("candidate-mismatch", relativePath);
  }
  return files.sort();
}

let sourceRoot;
try {
  sourceRoot = await canonicalExistingRoot(projectRoot);
} catch {
  fail("unsafe-source", "source");
}
const manifest = await readManifest(sourceRoot);
const destination = parseDestination();
const canonicalDestination = await prepareDestination(destination, sourceRoot);
for (const relativePath of manifest.files) {
  await copyManifestFile(relativePath, sourceRoot, canonicalDestination);
}

let copiedFiles;
try {
  copiedFiles = await collectCandidateFiles(canonicalDestination);
} catch {
  fail("candidate-mismatch", "candidate");
}
if (copiedFiles.length !== manifest.files.length
  || copiedFiles.some((path, index) => path !== manifest.files[index])) {
  fail("candidate-mismatch", "candidate");
}
