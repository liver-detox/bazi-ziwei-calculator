import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import {
  BirthRecordAnySchema,
  BirthRecordV1Schema,
  type BirthRecordAny,
  type BirthRecordV1
} from "../../shared/contracts.js";
import {
  PublicBirthRecordV2Schema,
  type PublicBirthRecordV2
} from "../../shared/provided-time-contracts.js";

type PublicBirthRecordV1 = Omit<BirthRecordV1, "privateName">;
export type PublicBirthRecord = PublicBirthRecordV1 | PublicBirthRecordV2;

export function publicBirthRecordMaterial(
  record: BirthRecordAny
): PublicBirthRecord {
  const parsed = BirthRecordAnySchema.parse(record);
  if (parsed.schemaVersion === "1.0.0") {
    const v1 = BirthRecordV1Schema.parse(parsed);
    const { privateName: _privateName, ...publicRecord } = v1;
    return publicRecord;
  }

  const {
    privateName: _privateName,
    providedTime,
    ...recordWithoutPrivateName
  } = parsed;
  const { sourceNote: _sourceNote, ...publicProvidedTime } = providedTime;
  return PublicBirthRecordV2Schema.parse({
    ...recordWithoutPrivateName,
    providedTime: publicProvidedTime
  });
}

export function sourceRecordFingerprint(record: BirthRecordAny): string {
  const material = canonicalize(publicBirthRecordMaterial(record));
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}
