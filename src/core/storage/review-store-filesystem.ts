import { randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ReviewError } from "../review/errors.js";
import { compareUnicodeCodePoints } from "../review/contracts/common.js";
import { canonicalJson } from "./canonical.js";

export interface DirectoryIdentity {
  path: string;
  dev: number | bigint;
  ino: number | bigint;
}

interface OwnedTransientIdentityBase {
  readonly path: string;
  readonly parentDirectory: string;
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly token: string;
}

interface ProvisionalReservationIdentity extends OwnedTransientIdentityBase {
  readonly kind: "reservation";
  readonly phase: "provisional";
}

export interface OwnedReservationIdentity extends OwnedTransientIdentityBase {
  readonly kind: "reservation";
  readonly phase: "durable";
}

export interface OwnedStagingIdentity extends OwnedTransientIdentityBase {
  readonly kind: "staging";
}

export type OwnedTransientIdentity = OwnedReservationIdentity | OwnedStagingIdentity;

type IssuedTransientIdentity = ProvisionalReservationIdentity | OwnedTransientIdentity;

const issuedOwnedTransients = new WeakSet<IssuedTransientIdentity>();

export function reviewStorageError(
  code: string,
  message: string,
  statusCode: 400 | 404 | 409 | 413 | 415 | 422
): ReviewError {
  return new ReviewError(code, message, statusCode);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function canonicalExistingDirectory(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value)) {
    throw reviewStorageError(code, message, 422);
  }
  try {
    const canonical = realpathSync(value);
    const status = lstatSync(canonical);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw reviewStorageError(code, message, 422);
  }
}

export function safeReviewPath(baseDirectory: string, ...segments: string[]): string {
  const base = resolve(baseDirectory);
  const target = resolve(base, ...segments);
  const boundary = relative(base, target);
  if (
    boundary === ""
    || (boundary !== ".." && !boundary.startsWith(`..${sep}`) && !isAbsolute(boundary))
  ) {
    return target;
  }
  throw reviewStorageError("UNSAFE_REVIEW_PATH", "复核存储路径超出允许边界", 422);
}

export function manifestArtifactPathIsSafe(path: string): boolean {
  if (
    path === ""
    || path.includes("\0")
    || path.includes("\\")
    || isAbsolute(path)
    || path === "manifest.json"
  ) return false;
  const normalized = path.split("/");
  return normalized.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export async function pathStatus(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readStableRegularFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular file");
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("file identity changed");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || bytes.byteLength !== opened.size
    ) throw new Error("file changed while reading");
    return bytes;
  } finally {
    await handle.close();
  }
}

export function parseCanonicalJson(bytes: Buffer): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = JSON.parse(text) as unknown;
  if (text !== canonicalJson(value)) throw new Error("JSON bytes are not canonical");
  return value;
}

export async function captureDirectoryIdentities(
  paths: readonly string[]
): Promise<DirectoryIdentity[]> {
  const identities: DirectoryIdentity[] = [];
  for (const path of paths) {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw reviewStorageError("UNSAFE_REVIEW_PATH", "复核存储目录身份无效", 422);
    }
    identities.push({ path, dev: status.dev, ino: status.ino });
  }
  return identities;
}

export async function assertDirectoryIdentities(
  chain: readonly DirectoryIdentity[]
): Promise<void> {
  try {
    for (const expected of chain) {
      const status = await lstat(expected.path);
      if (
        !status.isDirectory()
        || status.isSymbolicLink()
        || status.dev !== expected.dev
        || status.ino !== expected.ino
      ) throw new Error("directory identity changed");
    }
  } catch {
    throw reviewStorageError("UNSAFE_REVIEW_PATH", "复核存储目录在写入期间发生变化", 422);
  }
}

function transientOwnershipLost(): ReviewError {
  return reviewStorageError(
    "REVIEW_TRANSIENT_OWNERSHIP_LOST",
    "复核存储临时条目所有权已变化",
    409
  );
}

function issueTransientIdentity<T extends IssuedTransientIdentity>(identity: T): T {
  const issued = Object.freeze(identity) as T;
  issuedOwnedTransients.add(issued);
  return issued;
}

function promoteReservationIdentity(
  provisional: ProvisionalReservationIdentity
): OwnedReservationIdentity {
  if (!issuedOwnedTransients.has(provisional)) throw transientOwnershipLost();
  const durable = issueTransientIdentity({
    path: provisional.path,
    parentDirectory: provisional.parentDirectory,
    kind: "reservation",
    phase: "durable",
    dev: provisional.dev,
    ino: provisional.ino,
    token: provisional.token
  });
  issuedOwnedTransients.delete(provisional);
  return durable;
}

function issueProvisionalReservation(
  path: string,
  parentDirectory: string,
  dev: number | bigint,
  ino: number | bigint,
  token: string
): ProvisionalReservationIdentity {
  return issueTransientIdentity({
    path,
    parentDirectory,
    kind: "reservation",
    phase: "provisional",
    dev,
    ino,
    token
  });
}

function issueOwnedStaging(
  path: string,
  parentDirectory: string,
  dev: number | bigint,
  ino: number | bigint,
  token: string
): OwnedStagingIdentity {
  const identity = Object.freeze({
    path,
    parentDirectory,
    kind: "staging" as const,
    dev,
    ino,
    token
  });
  issuedOwnedTransients.add(identity);
  return identity;
}

export async function assertOwnedTransientIdentity(
  identity: OwnedTransientIdentity,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  if (!issuedOwnedTransients.has(identity)) throw transientOwnershipLost();
  await assertDirectoryIdentities(directoryChain);
  try {
    const status = await lstat(identity.path);
    const expectedType = identity.kind === "reservation"
      ? status.isFile() && !status.isSymbolicLink()
      : status.isDirectory() && !status.isSymbolicLink();
    if (!expectedType || status.dev !== identity.dev || status.ino !== identity.ino) {
      throw transientOwnershipLost();
    }
    if (identity.kind === "reservation") {
      const bytes = await readStableRegularFile(identity.path);
      if (bytes.toString("utf8") !== `${identity.token}\n`) throw transientOwnershipLost();
    }
  } catch {
    throw transientOwnershipLost();
  }
}

async function assertProvisionalReservationIdentity(
  identity: ProvisionalReservationIdentity,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  if (!issuedOwnedTransients.has(identity)) throw transientOwnershipLost();
  await assertDirectoryIdentities(directoryChain);
  try {
    const status = await lstat(identity.path);
    if (
      !status.isFile()
      || status.isSymbolicLink()
      || status.dev !== identity.dev
      || status.ino !== identity.ino
    ) throw transientOwnershipLost();
  } catch {
    throw transientOwnershipLost();
  }
}

async function removeProvisionalReservation(
  identity: ProvisionalReservationIdentity,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  await assertProvisionalReservationIdentity(identity, directoryChain);
  try {
    await rm(identity.path);
  } catch {
    throw transientOwnershipLost();
  }
  issuedOwnedTransients.delete(identity);
  await syncDirectory(identity.parentDirectory);
}

function assertReservationOperationIdentity(identity: OwnedTransientIdentity): void {
  if (
    !issuedOwnedTransients.has(identity)
    || identity.kind !== "reservation"
    || identity.phase !== "durable"
  ) throw transientOwnershipLost();
}

function assertStagingOperationIdentity(identity: OwnedTransientIdentity): void {
  if (!issuedOwnedTransients.has(identity) || identity.kind !== "staging") {
    throw transientOwnershipLost();
  }
}

export async function removeOwnedReservation(
  identity: OwnedReservationIdentity,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  assertReservationOperationIdentity(identity);
  await assertOwnedTransientIdentity(identity, directoryChain);
  try {
    await rm(identity.path);
  } catch {
    throw transientOwnershipLost();
  }
  issuedOwnedTransients.delete(identity);
  await syncDirectory(identity.parentDirectory);
}

export async function tryAcquireReservation(
  reservationPath: string,
  parentDirectory: string,
  directoryChain: readonly DirectoryIdentity[]
): Promise<OwnedReservationIdentity | undefined> {
  await assertDirectoryIdentities(directoryChain);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdReservation = false;
  let provisional: ProvisionalReservationIdentity | undefined;
  let durable: OwnedReservationIdentity | undefined;
  let failure: unknown;
  const token = randomUUID();
  try {
    handle = await open(reservationPath, "wx", 0o600);
    createdReservation = true;
    const opened = await handle.stat();
    if (!opened.isFile()) throw transientOwnershipLost();
    provisional = issueProvisionalReservation(
      reservationPath,
      parentDirectory,
      opened.dev,
      opened.ino,
      token
    );
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    durable = promoteReservationIdentity(provisional);
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure === undefined) return durable!;
  if (durable !== undefined) {
    await removeOwnedReservation(durable, directoryChain);
    throw failure;
  }
  if (provisional !== undefined) {
    await removeProvisionalReservation(provisional, directoryChain);
    throw failure;
  }
  if (createdReservation) throw transientOwnershipLost();
  if (isNodeError(failure) && failure.code === "EEXIST") return undefined;
  throw failure;
}

export async function createAtomicStagingDirectory(
  parentDirectory: string,
  sequentialId: string
): Promise<OwnedStagingIdentity> {
  const stagingDirectory = safeReviewPath(
    parentDirectory,
    `.${sequentialId}.tmp-${randomUUID()}`
  );
  await mkdir(stagingDirectory, { mode: 0o700 });
  try {
    const status = await lstat(stagingDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw transientOwnershipLost();
    return issueOwnedStaging(
      stagingDirectory,
      parentDirectory,
      status.dev,
      status.ino,
      randomUUID()
    );
  } catch {
    throw transientOwnershipLost();
  }
}

export async function removeOwnedStagingDirectory(
  identity: OwnedStagingIdentity,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  assertStagingOperationIdentity(identity);
  await assertOwnedTransientIdentity(identity, directoryChain);
  try {
    await rm(identity.path, { recursive: true });
  } catch {
    throw transientOwnershipLost();
  }
  issuedOwnedTransients.delete(identity);
}

export async function commitAtomicStagingDirectory(
  identity: OwnedStagingIdentity,
  targetDirectory: string,
  directoryChain: readonly DirectoryIdentity[]
): Promise<void> {
  assertStagingOperationIdentity(identity);
  await assertOwnedTransientIdentity(identity, directoryChain);
  await rename(identity.path, targetDirectory);
  issuedOwnedTransients.delete(identity);
  await syncDirectory(identity.parentDirectory);
}

export async function collectArtifactTree(
  directory: string
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const names = await readdir(current);
    for (const name of names) {
      const path = safeReviewPath(current, name);
      const status = await lstat(path);
      const relativePath = relative(directory, path).split(sep).join("/");
      if (status.isSymbolicLink()) throw new Error("artifact symlink rejected");
      if (status.isDirectory()) {
        directories.push(relativePath);
        await visit(path);
      } else if (status.isFile()) {
        if (!(current === directory && name === "manifest.json")) files.push(relativePath);
      } else {
        throw new Error("artifact type rejected");
      }
    }
  };
  await visit(directory);
  files.sort(compareUnicodeCodePoints);
  directories.sort(compareUnicodeCodePoints);
  return { files, directories };
}
