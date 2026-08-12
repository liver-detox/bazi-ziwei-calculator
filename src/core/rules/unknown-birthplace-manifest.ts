import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import { UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1 } from "../../shared/unknown-birthplace.js";

function canonicalContentSha256(value: unknown): string {
  const canonical = canonicalize(value);
  if (typeof canonical !== "string") {
    throw new TypeError("出生地未知规则无法序列化为规范 JSON");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const UNKNOWN_BIRTHPLACE_RULE_EVIDENCE = Object.freeze({
  ruleId: UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1.ruleId,
  rulesetVersion: UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1.rulesetVersion,
  contentSha256: canonicalContentSha256(UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1)
} as const);
