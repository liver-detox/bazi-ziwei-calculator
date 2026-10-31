import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { normalizeZipNames } from "./portable-zip.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:VITE_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));

function run(command, args, cwd, extraEnv = {}, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    child.stdout?.on("data", (bytes) => { output += bytes; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept(output.trim()) : reject(new Error(`Build step failed (${code}): ${command}`)));
  });
}

async function files(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await files(root, path));
    else if (entry.isFile() && !(await lstat(join(root, path))).isSymbolicLink()) found.push(path);
    else throw new Error(`Non-regular artifact entry: ${path}`);
  }
  return found.sort();
}

async function copy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function options() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("npm run build:portable -- --destination <new directory outside source> [--arch x64|arm64] [--runtime-archive <official Node ZIP>]\n");
    return null;
  }
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--destination", "--arch", "--runtime-archive"].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error("Invalid or duplicate build arguments; use --help");
    values.set(args[i], args[i + 1]);
  }
  if (!values.has("--destination")) throw new Error("--destination is required");
  const arch = values.get("--arch") ?? "x64";
  if (!["x64", "arm64"].includes(arch)) throw new Error("Architecture must be x64 or arm64");
  return { destination: resolve(values.get("--destination")), arch, archive: values.has("--runtime-archive") ? resolve(values.get("--runtime-archive")) : null };
}

async function requireAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Destination or archive already exists; choose a new destination");
}

async function validateDestination(path) {
  // Reject symlink ancestors and source overlap; never overwrite or clean user paths.
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== parent) throw new Error("Destination parent must use its real path (no symlink aliases)");
  const relation = relative(await realpath(projectRoot), path);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) throw new Error("Destination must be outside the source tree");
  for (const target of [path, `${path}.zip`, `${path}.zip.sha256`]) await requireAbsent(target);
}

async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "error" });
  if (!response.ok) throw new Error(`Official runtime download failed: HTTP ${response.status}`);
  await writeFile(target, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
}

async function auditDependencies(app, lock) {
  const packages = [];
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path || metadata.dev) continue;
    const installed = await readJson(join(app, path, "package.json"));
    if (metadata.hasInstallScript || installed.os || installed.cpu || installed.libc || ["preinstall", "install", "postinstall"].some((key) => installed.scripts?.[key])) {
      throw new Error(`Dependency requires platform/install review: ${path}`);
    }
    packages.push({ name: installed.name, version: installed.version, license: installed.license ?? "See package license" });
  }
  for (const path of await files(join(app, "node_modules"))) {
    if (/\.(?:node|exe|dll|dylib|so|bat|cmd)$/i.test(path) || /(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:log|pem|key|p12|db|sqlite3?))$/i.test(path)) throw new Error(`Unexpected production dependency file: ${path}`);
  }
  for (const name of ["tsx", "esbuild", "vite", "typescript", "vitest"]) {
    try { await lstat(join(app, "node_modules", name)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error(`Build tool leaked into runtime: ${name}`);
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

async function build(config) {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Builder requires Node.js >=24");
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !isAbsolute(npmCli)) throw new Error("Run via npm run build:portable so the builder can locate npm safely");
  await validateDestination(config.destination);
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "bazi-portable-"));
  let staging;
  try {
    const source = join(temporary, "source");
    const bundle = join(temporary, "bundle");
    const app = join(bundle, "app");
    const runtime = await readJson(join(projectRoot, "release/windows-runtime.json"));
    const pinned = runtime.architectures[config.arch];
    const runtimeName = `node-v${runtime.version}-win-${config.arch}`;
    const runtimeUrl = `https://nodejs.org/download/release/v${runtime.version}/${runtimeName}.zip`;
    const archive = config.archive ?? join(temporary, "node.zip");
    if (!config.archive) await download(runtimeUrl, archive);
    if (sha256(await readFile(archive)) !== pinned.archiveSha256) throw new Error("Official Node ZIP SHA-256 mismatch");
    const extracted = join(temporary, "runtime-extract");
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:PORTABLE_INPUT -DestinationPath $env:PORTABLE_OUTPUT"], temporary, { PORTABLE_INPUT: archive, PORTABLE_OUTPUT: extracted });
    } else {
      await run("unzip", ["-q", archive, `${runtimeName}/node.exe`, `${runtimeName}/LICENSE`, "-d", extracted], temporary);
    }
    const runtimeRoot = join(extracted, runtimeName);
    if (sha256(await readFile(join(runtimeRoot, "node.exe"))) !== pinned.nodeSha256) throw new Error("Official node.exe SHA-256 mismatch");
    if ((await readFile(join(runtimeRoot, "LICENSE"))).length < 100) throw new Error("Node license is missing or empty");

    await run(process.execPath, [join(projectRoot, "scripts/build-public-candidate.mjs"), "--destination", source], projectRoot);
    await run(process.execPath, [join(source, "scripts/check-public-candidate.mjs"), "--root", source], source);
    const npm = (args, cwd) => run(process.execPath, [npmCli, ...args, "--no-audit", "--no-fund"], cwd);
    await npm(["ci", "--include=dev"], source);
    await npm(["run", "typecheck"], source);
    await npm(["run", "build"], source);
    const sourceId = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { CURRENT_SOURCE_ID } from './src/core/source-identity.ts'; process.stdout.write(CURRENT_SOURCE_ID)"], source, {}, true);
    if (!/^src1-[a-f0-9]{16}$/.test(sourceId)) throw new Error("Invalid source identity");
    const portableConfig = {
      extends: "./tsconfig.node.json",
      compilerOptions: { noEmit: false, noEmitOnError: true, rootDir: ".", outDir: app, sourceMap: false, declaration: false },
      include: ["src/server/**/*.ts"]
    };
    await writeFile(join(source, "tsconfig.portable.json"), JSON.stringify(portableConfig));
    await run(process.execPath, [join(source, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.portable.json"], source);
    for (const path of await files(join(app, "src"))) {
      if (!path.endsWith(".js")) throw new Error(`Unexpected compiler output: ${path}`);
    }
    const publicManifest = await readJson(join(source, "release/public-files.json"));
    for (const path of publicManifest.files.filter((path) => path.startsWith("src/data/") && path.endsWith(".json"))) await copy(join(source, path), join(app, path));
    for (const path of await files(join(source, "dist"))) await copy(join(source, "dist", path), join(app, "dist", path));
    await writeFile(join(app, "src/core/source-identity.js"), `// Frozen from the clean public source used for this build.\nexport const CURRENT_SOURCE_ID = ${JSON.stringify(sourceId)};\n`);

    for (const path of ["package.json", "package-lock.json"]) await copy(join(source, path), join(app, path));
    await npm(["ci", "--omit=dev", "--ignore-scripts", "--no-bin-links"], app);
    const lock = await readJson(join(app, "package-lock.json"));
    const dependencies = await auditDependencies(app, lock);
    const pkg = await readJson(join(app, "package.json"));
    await writeFile(join(app, "package.json"), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: "module", imports: { "#source-identity": "./src/core/source-identity.js" }, engines: pkg.engines, dependencies: pkg.dependencies }, null, 2) + "\n");
    await rm(join(app, "package-lock.json"));
    for (const [from, to] of [["Start.cmd", "Start.cmd"], ["portable.mjs", "app/portable.mjs"], ["README.txt", "README.txt"]]) await copy(join(source, "scripts/portable", from), join(bundle, to));
    for (const path of publicManifest.files.filter((path) => path === "LICENSE" || path === "PRIVACY.md" || path.startsWith("LICENSES/"))) await copy(join(source, path), join(bundle, path));
    await copy(join(runtimeRoot, "node.exe"), join(bundle, "runtime/node.exe"));
    await copy(join(runtimeRoot, "LICENSE"), join(bundle, "runtime/LICENSE"));
    await writeFile(join(bundle, "THIRD-PARTY-NOTICES.txt"), "Third-party production packages (license texts retained in app/node_modules; Node license in runtime/LICENSE):\n" + dependencies.map((pkg) => `${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.license)}`).join("\n") + "\n");
    await run(process.execPath, [join(app, "portable.mjs"), "--check"], temporary);
    const inventory = {};
    for (const path of await files(bundle)) {
      if (/(?:^|\/)(?:\.env(?:\..*)?|[^/]*\.(?:log|pem|key|p12|db|sqlite3?))$/i.test(path)) throw new Error(`Forbidden artifact file: ${path}`);
      inventory[path] = sha256(await readFile(join(bundle, path)));
    }
    await writeFile(join(bundle, "PORTABLE-MANIFEST.json"), JSON.stringify({ schemaVersion: "1.0.0", calculatorVersion: pkg.version, sourceId, target: `win-${config.arch}`, runtime: { version: runtime.version, archiveUrl: runtimeUrl, ...pinned }, packageLockSha256: sha256(await readFile(join(source, "package-lock.json"))), validation: { buildHost: process.platform, windowsManualAcceptance: "not-performed", note: "Build and layout checks only; run the synthetic smoke check and manual Windows acceptance separately." }, dependencies, files: inventory }, null, 2) + "\n");

    // Stage beside the destination so exclusive archive links stay on one volume.
    staging = await mkdtemp(join(dirname(config.destination), ".portable-staging-"));
    const stagedBundle = join(staging, basename(config.destination));
    for (const path of await files(bundle)) await copy(join(bundle, path), join(stagedBundle, path));
    const zip = join(staging, "payload.zip");
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:PORTABLE_INPUT, $env:PORTABLE_OUTPUT, [IO.Compression.CompressionLevel]::Optimal, $true)"], staging, { PORTABLE_INPUT: stagedBundle, PORTABLE_OUTPUT: zip });
    } else {
      await run("zip", ["-q", "-r", "-X", zip, basename(stagedBundle)], staging);
    }
    await writeFile(zip, normalizeZipNames(await readFile(zip)));
    const roundtrip = join(staging, "roundtrip");
    if (process.platform === "win32") {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PORTABLE_INPUT, $env:PORTABLE_OUTPUT)"], staging, { PORTABLE_INPUT: zip, PORTABLE_OUTPUT: roundtrip });
    } else {
      await run("unzip", ["-q", zip, "-d", roundtrip], staging);
    }
    const expectedFiles = await files(stagedBundle);
    const extractedRoot = join(roundtrip, basename(stagedBundle));
    if (JSON.stringify(await files(extractedRoot)) !== JSON.stringify(expectedFiles)) throw new Error("ZIP round-trip inventory mismatch");
    for (const path of expectedFiles) {
      if (sha256(await readFile(join(stagedBundle, path))) !== sha256(await readFile(join(extractedRoot, path)))) throw new Error(`ZIP round-trip SHA-256 mismatch: ${path}`);
    }
    await writeFile(join(staging, "payload.zip.sha256"), `${sha256(await readFile(zip))}  ${config.destination.split(sep).at(-1)}.zip\n`);
    for (const target of [config.destination, `${config.destination}.zip`, `${config.destination}.zip.sha256`]) await requireAbsent(target);
    const created = [];
    try {
      await mkdir(config.destination);
      created.push(config.destination);
      for (const path of await files(stagedBundle)) await copy(join(stagedBundle, path), join(config.destination, path));
      // Exclusive hard links on this volume cannot overwrite an existing archive.
      for (const [from, to] of [[zip, `${config.destination}.zip`], [join(staging, "payload.zip.sha256"), `${config.destination}.zip.sha256`]]) {
        await link(from, to);
        created.push(to);
      }
    } catch (error) {
      for (const path of created.reverse()) await rm(path, { recursive: true, force: true });
      throw error;
    }
    process.stdout.write(`PORTABLE_BUILD_OK win-${config.arch}; Windows manual acceptance NOT performed\n${config.destination}\n${config.destination}.zip\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

try {
  const config = options();
  if (config) await build(config);
} catch (error) {
  process.stderr.write(`PORTABLE_BUILD_FAILED: ${error.message}\n`);
  process.exitCode = 1;
}
