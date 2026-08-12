import { createHash } from "node:crypto";

import { canonicalize } from "json-canonicalize";

import {
  BaziDetailBaseChartSetSourceSchema,
  BaziDetailV1Schema,
  StrictCompleteBaziChartV1Schema,
  type BaziDetailV1
} from "./bazi-detail-contract.js";
import type { BaziChartV1, DualTrackChartSetV1 } from "./types.js";
import { PublicBirthRecordV2Schema, TimeEvidenceV2Schema, type PublicBirthRecordV2, type TimeEvidenceV2 } from "../../shared/provided-time-contracts.js";
import { sourceRecordFingerprint } from "../time/source-record-fingerprint.js";
import { resolveEngineLocalDateTime, toMinuteLocalDateTime } from "./input.js";

export const BAZI_DETAIL_FINGERPRINT_DOMAINS = Object.freeze({
  publicBirthRecord: "cyber-saga-bazi-detail-public-birth-record-v1",
  timeEvidence: "cyber-saga-bazi-detail-time-evidence-v1",
  baseBaziProjection: "cyber-saga-bazi-detail-base-bazi-projection-v1",
  targetYears: "cyber-saga-bazi-detail-target-years-v1",
  sourceBaziCandidate: "cyber-saga-bazi-detail-source-bazi-candidate-v1",
  detail: "cyber-saga-bazi-detail-v1"
} as const);
export type BaziDetailFingerprintDomain = typeof BAZI_DETAIL_FINGERPRINT_DOMAINS[keyof typeof BAZI_DETAIL_FINGERPRINT_DOMAINS];

export interface BaziDetailSourcesV1 { publicBirthRecord: PublicBirthRecordV2; timeEvidence: TimeEvidenceV2; baseChartSet: DualTrackChartSetV1; }

function canonical(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== "string") throw new TypeError("八字详盘指纹投影无法规范序列化");
  return result;
}
function fingerprint(domain: BaziDetailFingerprintDomain, projection: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(baziDetailFingerprintPreimage(domain, projection)).digest("hex")}`;
}
function sortedUnique(values: readonly string[] | readonly number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

/** A byte-level protocol: UTF-8 domain, one NUL byte, canonical JSON with no newline. */
export function baziDetailFingerprintPreimage(domain: BaziDetailFingerprintDomain, strictProjection: unknown): Uint8Array {
  return new TextEncoder().encode(`${domain}\0${canonical(strictProjection)}`);
}

function baseBaziProjection(chartSet: DualTrackChartSetV1): unknown {
  return {
    caseId: chartSet.caseId,
    targetYears: chartSet.targetYears,
    candidates: chartSet.candidates.map((candidate) => ({ candidateId: candidate.candidateId, bazi: candidate.bazi }))
  };
}

function sourceBaziProjection(input: { caseId: string; candidateId: string; bazi: BaziChartV1 }): unknown {
  return { caseId: input.caseId, candidateId: input.candidateId, bazi: StrictCompleteBaziChartV1Schema.parse(input.bazi) };
}

function fail(code: string): never { throw new Error(code); }
function sameOrdered(left: readonly string[] | readonly number[], right: readonly string[] | readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseStrictBaziDetailSources(sources: BaziDetailSourcesV1): BaziDetailSourcesV1 {
  const publicBirthRecord = PublicBirthRecordV2Schema.parse(sources.publicBirthRecord);
  const timeEvidence = TimeEvidenceV2Schema.parse(sources.timeEvidence);
  const baseChartSet = BaziDetailBaseChartSetSourceSchema.parse(sources.baseChartSet) as unknown as DualTrackChartSetV1;
  if (publicBirthRecord.caseId !== timeEvidence.caseId || publicBirthRecord.caseId !== baseChartSet.caseId) fail("BAZI_DETAIL_SOURCE_CASE_ID_MISMATCH");
  if (sourceRecordFingerprint(publicBirthRecord) !== timeEvidence.sourceRecordFingerprint) fail("BAZI_DETAIL_SOURCE_RECORD_FINGERPRINT_MISMATCH");
  if (!sortedUnique(baseChartSet.targetYears)) fail("BAZI_DETAIL_SOURCE_TARGET_YEARS_NOT_CANONICAL");
  const evidenceIds = timeEvidence.candidates.map((candidate) => candidate.id);
  const chartIds = baseChartSet.candidates.map((candidate) => candidate.candidateId);
  if (!sortedUnique(evidenceIds) || !sortedUnique(chartIds) || !sameOrdered(evidenceIds, chartIds)) fail("BAZI_DETAIL_SOURCE_CANDIDATES_NOT_CANONICAL");
  for (const chartCandidate of baseChartSet.candidates) {
    const evidenceCandidate = timeEvidence.candidates.find((candidate) => candidate.id === chartCandidate.candidateId)!;
    const resolution = timeEvidence.calendarResolutions.find((item) => item.id === evidenceCandidate.calendarResolutionId)!;
    if (chartCandidate.basis !== evidenceCandidate.basis || chartCandidate.dayBoundary !== evidenceCandidate.dayBoundary || chartCandidate.calendarResolutionId !== evidenceCandidate.calendarResolutionId || chartCandidate.calendarBasis !== evidenceCandidate.calendarBasis) fail("BAZI_DETAIL_SOURCE_CANDIDATE_BINDING_MISMATCH");
    const bazi = chartCandidate.bazi;
    const ziwei = chartCandidate.ziwei;
    const sourceDateTime = toMinuteLocalDateTime(resolveEngineLocalDateTime(evidenceCandidate));
    const forwardLateZi = evidenceCandidate.ziSegment === "late" && evidenceCandidate.dayBoundary === "forward";
    const sourceTimeIndex = evidenceCandidate.ziSegment === "late" ? 12 : evidenceCandidate.earthlyBranch.index;
    const engineInputDate = forwardLateZi
      ? evidenceCandidate.localDateTime.slice(0, 10)
      : sourceDateTime.slice(0, 10);
    if (bazi.candidateId !== chartCandidate.candidateId || bazi.input.sourceLocalDateTime !== sourceDateTime || bazi.input.calculationLocalDateTime !== evidenceCandidate.localDateTime || bazi.input.earthlyBranchIndex !== evidenceCandidate.earthlyBranch.index || bazi.calendar.solarDate !== resolution.solarDate) fail("BAZI_DETAIL_SOURCE_BAZI_BINDING_MISMATCH");
    if (ziwei.candidateId !== chartCandidate.candidateId || ziwei.input.sourceLocalDateTime !== sourceDateTime || ziwei.input.calculationLocalDateTime !== evidenceCandidate.localDateTime || ziwei.input.sourceZiSegment !== evidenceCandidate.ziSegment || ziwei.input.engineInputDate !== engineInputDate || ziwei.configuration.sourceTimeIndex !== sourceTimeIndex || ziwei.configuration.timeIndex !== (forwardLateZi ? 0 : sourceTimeIndex) || ziwei.solarDate !== engineInputDate || ziwei.gender !== publicBirthRecord.gender) fail("BAZI_DETAIL_SOURCE_ZIWEI_BINDING_MISMATCH");
    const baziYears = bazi.annualFortunes.map((fortune) => fortune.year);
    const ziweiYears = ziwei.yearlyFortunes.map((fortune) => fortune.targetYear);
    if (!sortedUnique(baziYears) || !sortedUnique(ziweiYears) || !sameOrdered(baziYears, baseChartSet.targetYears) || !sameOrdered(ziweiYears, baseChartSet.targetYears)) fail("BAZI_DETAIL_SOURCE_ANNUAL_YEARS_MISMATCH");
  }
  return { publicBirthRecord, timeEvidence, baseChartSet };
}

export function computeBaziDetailSourceIdentityFromStrict(strict: BaziDetailSourcesV1): BaziDetailV1["sourceIdentity"] {
  return {
    publicBirthRecordFingerprint: fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.publicBirthRecord, strict.publicBirthRecord),
    timeEvidenceFingerprint: fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.timeEvidence, strict.timeEvidence),
    baseBaziProjectionFingerprint: fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.baseBaziProjection, baseBaziProjection(strict.baseChartSet)),
    targetYearsFingerprint: fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.targetYears, strict.baseChartSet.targetYears)
  };
}

export function computeBaziDetailSourceIdentity(sources: BaziDetailSourcesV1): BaziDetailV1["sourceIdentity"] {
  return computeBaziDetailSourceIdentityFromStrict(parseStrictBaziDetailSources(sources));
}

export function computeSourceBaziCandidateFingerprint(input: { caseId: string; candidateId: string; bazi: BaziChartV1 }): `sha256:${string}` {
  return fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.sourceBaziCandidate, sourceBaziProjection(input));
}

export function computeSourceBaziCandidateFingerprintFromStrict(input: { caseId: string; candidateId: string; bazi: BaziChartV1 }): `sha256:${string}` {
  return fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.sourceBaziCandidate, {
    caseId: input.caseId,
    candidateId: input.candidateId,
    bazi: input.bazi
  });
}

export function computeBaziDetailFingerprint(body: Omit<BaziDetailV1, "detailFingerprint">): `sha256:${string}` {
  const parsed = BaziDetailV1Schema.parse({ ...body, detailFingerprint: `sha256:${"0".repeat(64)}` });
  const { detailFingerprint: _detailFingerprint, ...projection } = parsed;
  return fingerprint(BAZI_DETAIL_FINGERPRINT_DOMAINS.detail, projection);
}

export function parseBoundBaziDetail(input: BaziDetailSourcesV1 & { detail: unknown }): BaziDetailV1 {
  const sources = parseStrictBaziDetailSources(input);
  const detail = BaziDetailV1Schema.parse(input.detail);
  if (detail.caseId !== sources.publicBirthRecord.caseId) fail("BAZI_DETAIL_CASE_ID_MISMATCH");
  if (!sameOrdered(detail.targetYears, sources.baseChartSet.targetYears)) fail("BAZI_DETAIL_TARGET_YEARS_MISMATCH");
  const sourceIdentity = computeBaziDetailSourceIdentityFromStrict(sources);
  if (canonical(detail.sourceIdentity) !== canonical(sourceIdentity)) fail("BAZI_DETAIL_SOURCE_IDENTITY_MISMATCH");
  const sourceCandidates = sources.baseChartSet.candidates;
  if (!sameOrdered(detail.candidates.map((candidate) => candidate.candidateId), sourceCandidates.map((candidate) => candidate.candidateId))) fail("BAZI_DETAIL_CANDIDATES_MISMATCH");
  detail.candidates.forEach((candidate, index) => {
    const base = sourceCandidates[index];
    if (candidate.sourceBaziCandidateFingerprint !== computeSourceBaziCandidateFingerprintFromStrict({ caseId: sources.baseChartSet.caseId, candidateId: base.candidateId, bazi: base.bazi })) fail("BAZI_DETAIL_CANDIDATE_FINGERPRINT_MISMATCH");
    if (!sameOrdered(candidate.daYunDetails.map((item) => item.index), base.bazi.luck.daYun.map((item) => item.index))) fail("BAZI_DETAIL_DAYUN_INDEX_MISMATCH");
    if (!sameOrdered(candidate.annualDetails.map((item) => item.year), base.bazi.annualFortunes.map((item) => item.year)) || candidate.annualDetails.some((item, annualIndex) => item.daYunIndex !== base.bazi.annualFortunes[annualIndex].daYunIndex)) fail("BAZI_DETAIL_ANNUAL_KEY_MISMATCH");
  });
  if (detail.detailFingerprint !== computeBaziDetailFingerprint((({ detailFingerprint: _fingerprint, ...body }) => body)(detail) as Omit<BaziDetailV1, "detailFingerprint">)) fail("BAZI_DETAIL_FINGERPRINT_MISMATCH");
  return detail as BaziDetailV1;
}
