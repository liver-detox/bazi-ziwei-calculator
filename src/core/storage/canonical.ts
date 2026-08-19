import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

import { canonicalize } from "json-canonicalize";

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== "string") {
    throw new TypeError("数据无法序列化为规范 JSON");
  }
  return `${result}\n`;
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function writeCanonicalJson(filePath: string, value: unknown, mode = 0o600): Promise<void> {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(canonicalJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
