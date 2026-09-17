import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_ENTRIES = new Set([
  "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.node.json",
  "scripts/start-local.cmd", "scripts/start-local.command"
]);

/** Hash allowlisted runtime paths and bytes, never cases, outputs, machine, Git or time metadata. */
export function calculateSourceId(root: string): string {
  const canonicalRoot = realpathSync(root);
  const manifest = JSON.parse(readFileSync(resolve(canonicalRoot, "release/public-files.json"), "utf8")) as { files: string[] };
  const paths = manifest.files.filter((path) => path.startsWith("src/") || path.startsWith("public/") || RUNTIME_ENTRIES.has(path));
  const hash = createHash("sha256").update("calculator-public-runtime-v1\0");
  for (const path of [...paths].sort()) {
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".") || path.includes("\\")) {
      throw new Error("SOURCE_ID_INVALID_PUBLIC_PATH");
    }
    const absolute = resolve(canonicalRoot, path);
    if (realpathSync(absolute) !== absolute) throw new Error("SOURCE_ID_SYMLINK_NOT_ALLOWED");
    const bytes = readFileSync(absolute);
    hash.update(`${Buffer.byteLength(path, "utf8")}:${path}:${bytes.length}:`).update(bytes);
  }
  return `src1-${hash.digest("hex").slice(0, 16)}`;
}

export const CURRENT_SOURCE_ID = calculateSourceId(fileURLToPath(new URL("../../", import.meta.url)));
