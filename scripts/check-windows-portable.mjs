import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Uses only invented inputs and a disposable data directory, never the package's data/.
const args = process.argv.slice(2);
const hostNode = args.includes("--host-node");
const positional = args.filter((argument) => argument !== "--host-node");
if (positional.length !== 2 || positional[0] !== "--root" || !positional[1]
  || args.filter((argument) => argument === "--host-node").length > 1) {
  process.stderr.write("Usage: node scripts/check-windows-portable.mjs --root <directory> [--host-node]\n");
  process.exit(2);
}
if (!hostNode && process.platform !== "win32") {
  process.stderr.write("Windows is required to check the bundled node.exe. Use --host-node only for a host-platform smoke check.\n");
  process.exit(2);
}

const root = resolve(positional[1]);
const executable = hostNode ? process.execPath : join(root, "runtime/node.exe");
const entry = join(root, "app/portable.mjs");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH)$/iu.test(key)));
let temporary;
let child;
let childClosed;

function safeRelativePath(path) {
  return path.length > 0 && !/[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(path)
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."
      && !/[ .]$/u.test(segment) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment));
}

async function packageFiles(prefix = "") {
  const found = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    assert.ok(safeRelativePath(path), "Package contains an unsafe path");
    const status = await lstat(join(root, path));
    assert.equal(status.isSymbolicLink(), false, "Package contains a symbolic link");
    if (status.isDirectory()) found.push(...await packageFiles(path));
    else {
      assert.ok(status.isFile(), "Package contains a non-regular file");
      found.push(path);
    }
  }
  return found.sort();
}

async function checkManifest() {
  const status = await lstat(root);
  assert.ok(status.isDirectory() && !status.isSymbolicLink(), "Package root must be a real directory");
  const files = await packageFiles();
  assert.ok(files.includes("PORTABLE-MANIFEST.json"), "Package manifest is missing");
  const manifest = JSON.parse(await readFile(join(root, "PORTABLE-MANIFEST.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "1.0.0", "Unsupported package manifest");
  assert.match(manifest.sourceId, /^src1-[a-f0-9]{16}$/u);
  assert.match(manifest.target, /^win-(?:x64|arm64)$/u);
  assert.ok(manifest.files && typeof manifest.files === "object" && !Array.isArray(manifest.files), "Invalid package inventory");
  assert.match(manifest.runtime?.version, /^\d+\.\d+\.\d+$/u);
  assert.match(manifest.runtime?.nodeSha256, /^[a-f0-9]{64}$/u);
  for (const [path, hash] of Object.entries(manifest.files)) {
    assert.ok(safeRelativePath(path) && path !== "PORTABLE-MANIFEST.json", "Manifest contains an unsafe path");
    assert.match(hash, /^[a-f0-9]{64}$/u, "Manifest contains an invalid SHA-256");
  }
  assert.deepEqual(files.filter((path) => path !== "PORTABLE-MANIFEST.json"), Object.keys(manifest.files).sort(), "Package inventory differs from its manifest");
  for (const path of files.filter((path) => path !== "PORTABLE-MANIFEST.json")) {
    assert.equal(sha256(await readFile(join(root, path))), manifest.files[path], `Package file SHA-256 mismatch: ${path}`);
  }
  assert.equal(manifest.files["runtime/node.exe"], manifest.runtime.nodeSha256, "Bundled Node SHA-256 does not match runtime metadata");
  for (const path of ["app/portable.mjs", "app/src/server/index.js", "app/src/core/source-identity.js", "app/package.json", "app/dist/index.html"]) {
    assert.ok(Object.hasOwn(manifest.files, path), "Required portable runtime file is missing");
  }
  const browserScripts = files.filter((path) => path.startsWith("app/dist/") && path.endsWith(".js"));
  let browserSourceIdFound = false;
  for (const path of browserScripts) {
    if ((await readFile(join(root, path), "utf8")).includes(manifest.sourceId)) browserSourceIdFound = true;
  }
  assert.ok(browserSourceIdFound, "Browser build does not contain the package source identity");
  if (!hostNode) {
    const { stdout } = await promisify(execFile)(executable, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch,version:process.versions.node})"], {
      cwd: root, env: cleanEnvironment, timeout: 10_000, maxBuffer: 4096, windowsHide: true
    });
    const actual = JSON.parse(stdout);
    assert.deepEqual(actual, { platform: "win32", arch: manifest.target.slice(4), version: manifest.runtime.version }, "Bundled Node platform, architecture or version mismatch");
  }
  return manifest;
}

async function absent(path) {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function stop() {
  if (!child) return;
  const current = child;
  child = undefined;
  if (current.exitCode === null && current.signalCode === null) current.kill();
  let timer;
  try {
    await Promise.race([
      childClosed,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          current.kill("SIGKILL");
          reject(new Error("Server did not stop in time"));
        }, 10_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  const env = { ...cleanEnvironment };
  Object.assign(env, {
    CYBER_SAGA_DATA_DIR: join(temporary, "data"),
    CYBER_SAGA_NO_OPEN: "1",
    CYBER_SAGA_PORT: "0"
  });
  child = spawn(executable, [entry], {
    cwd: join(temporary, "unrelated working directory"), env,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  childClosed = new Promise((accept) => child.once("close", accept));
  const current = child;
  let output = "";
  let timer;
  try {
    return await new Promise((accept, reject) => {
      timer = setTimeout(() => reject(new Error("Server readiness timed out")), 30_000);
      current.once("error", () => reject(new Error("Could not execute the selected Node runtime")));
      current.once("exit", () => reject(new Error("Server exited before readiness")));
      current.stderr.resume();
      current.stdout.on("data", (chunk) => {
        output = (output + chunk.toString("utf8")).slice(-8192);
        const url = /http:\/\/127\.0\.0\.1:(\d{1,5})(?=\s|$)/u.exec(output);
        if (url) accept(url[0]);
      });
    });
  } finally {
    clearTimeout(timer);
  }
}

async function request(base, path, options = {}) {
  return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(30_000) });
}

async function externalHostStatus(base) {
  // fetch can replace Host with the destination host; raw HTTP tests the actual guard.
  return new Promise((accept, reject) => {
    const outgoing = httpRequest(`${base}/api/health`, {
      headers: { Host: "example.com" }, signal: AbortSignal.timeout(30_000)
    }, (response) => {
      response.resume();
      accept(response.statusCode);
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function json(base, path, expectedStatus = 200, options = {}) {
  const response = await request(base, path, options);
  assert.equal(response.status, expectedStatus, `${path}: unexpected HTTP status`);
  return response.json();
}

async function token(base) {
  const response = await request(base, "/runtime-config.js");
  assert.equal(response.status, 200);
  const value = /sessionToken:\s*"([A-Za-z0-9_-]+)"/u.exec(await response.text())?.[1];
  assert.ok(value && value.length >= 32, "Runtime session token is missing");
  return value;
}

function post(sessionToken, body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-cyber-session-token": sessionToken },
    body: JSON.stringify(body)
  };
}

function synthetic(caseId, fourCandidates = false) {
  return {
    birthRecord: {
      schemaVersion: "2.0.0", caseId, alias: "DEMO-PORTABLE", gender: "女",
      calendar: fourCandidates
        ? { type: "lunar", date: "2023-02-01", leapMonth: "unknown" }
        : { type: "solar", date: "2000-01-15", leapMonth: false },
      providedTime: {
        localTime: fourCandidates ? "23:30" : "12:00",
        basis: "civil_clock_provided", precision: "minute", sourceType: "unknown"
      },
      policy: { lateZi: "candidates" }
    },
    targetYears: fourCandidates ? [] : [2026, 2030],
    workflowStatus: "review"
  };
}

try {
  const manifest = await checkManifest();
  await Promise.all([access(executable), access(entry), access(join(root, "app/package.json"))]);
  assert.ok(await absent(join(root, "data")), "Use a fresh package without user data");
  assert.ok(await absent(join(root, "app/data")), "Use a fresh package without user data");
  temporary = await mkdtemp(join(tmpdir(), "cyber-saga-portable-synthetic-"));
  await mkdir(join(temporary, "unrelated working directory"));
  let base = await start();
  assert.equal((await json(base, "/api/health")).scope, "local-only");
  assert.deepEqual(await json(base, "/api/cases"), []);

  const page = await request(base, "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/u);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/gu)].map((match) => match[1]);
  assert.ok(assets.some((asset) => asset.endsWith(".js")), "Built JavaScript is missing");
  assert.ok(assets.some((asset) => asset.endsWith(".css")), "Built CSS is missing");
  for (const asset of assets) assert.equal((await request(base, asset)).status, 200);
  for (const path of ["/package.json", "/data/", "/app/package.json", "/runtime/node.exe"]) {
    assert.equal((await request(base, path)).status, 404, "Non-static package files must stay private");
  }
  assert.equal(await externalHostStatus(base), 421);
  assert.equal((await request(base, "/api/health", { headers: { Origin: "https://example.com" } })).status, 403);
  const sessionToken = await token(base);
  const ordinaryRequest = synthetic("CS-2000-991");
  assert.equal((await request(base, "/api/cases", post("", ordinaryRequest))).status, 401);
  const created = await json(base, "/api/cases", 201, post(sessionToken, ordinaryRequest));
  const candidates = created.snapshot.timeEvidence.candidates;
  assert.equal(candidates.length, 1);
  const revisionPath = `/api/cases/${created.revision.caseId}/revisions/${created.revision.revisionId}`;
  const document = await json(base, `${revisionPath}/chart-document`, 200, post(sessionToken, { candidateId: candidates[0].id }));
  assert.equal(document.subject.nameOrAlias, "DEMO-PORTABLE");
  assert.match(document.exportSourceId, /^src1-[a-f0-9]{16}$/u);
  assert.equal(document.exportSourceId, manifest.sourceId, "Export source identity differs from the package manifest");
  const sourceIdentity = await readFile(join(root, "app/src/core/source-identity.js"), "utf8");
  assert.ok(sourceIdentity.includes(document.exportSourceId), "Runtime source identity does not match the export");
  assert.deepEqual(document.bazi.chart.annualFortunes.map((item) => item.year), [2026, 2030]);
  assert.deepEqual(document.ziwei.yearlyFortunes.map((item) => item.targetYear), [2026, 2030]);
  assert.equal(document.ziwei.palaces.length, 12);
  const multiple = await json(base, "/api/cases", 201, post(sessionToken, synthetic("CS-2023-992", true)));
  assert.equal(multiple.snapshot.timeEvidence.candidates.length, 4);

  await stop();
  base = await start();
  const persisted = await json(base, "/api/cases");
  assert.deepEqual(persisted.map((item) => item.caseId).sort(), ["CS-2000-991", "CS-2023-992"]);
  const saved = await json(base, revisionPath);
  assert.equal(saved.input.alias, "DEMO-PORTABLE");
  const newToken = await token(base);
  assert.notEqual(newToken, sessionToken);
  const newDocument = await json(base, `${revisionPath}/chart-document`, 200, post(newToken, { candidateId: candidates[0].id }));
  assert.equal(newDocument.exportSourceId, document.exportSourceId);
  assert.deepEqual(newDocument.bazi, document.bazi);
  await stop();
  assert.ok(await absent(join(root, "data")));
  assert.ok(await absent(join(root, "app/data")));
  process.stdout.write(hostNode
    ? "PORTABLE_CHECK_OK host-node; Windows runtime and launcher remain unverified.\n"
    : "PORTABLE_CHECK_OK bundled-windows-node; interactive Windows browser acceptance remains required.\n");
} catch (error) {
  process.stderr.write(`PORTABLE_CHECK_FAILED ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
} finally {
  await stop();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
