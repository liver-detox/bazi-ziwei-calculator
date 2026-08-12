import type { BirthRecordV1 } from "./contracts.js";

export const UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1 = Object.freeze({
  ruleId: "unknown-birthplace-beijing-basis",
  rulesetVersion: "CyberSaga-Unknown-Birthplace-v1",
  noticeVersion: "CyberSaga-Unknown-Birthplace-Notice-v1",
  label: "出生地未知（北京时间基准；非北京市）",
  countryCode: "CN",
  longitude: 120,
  timeZone: "Asia/Shanghai",
  standardOffsetMinutes: 480,
  clockConvention: "beijing",
  coordinateSource: "unknown",
  trueSolar: "civil_only",
  dst: "iana"
} as const);

export type UnknownBirthplaceBasisClassification =
  | "not_unknown"
  | "valid_basis"
  | "invalid_basis";

export interface UnknownBirthplaceBasisIssue {
  path: string;
  message: string;
}

function issue(path: string, message: string): UnknownBirthplaceBasisIssue {
  return { path, message };
}

export function unknownBirthplaceBasisIssues(record: BirthRecordV1): UnknownBirthplaceBasisIssue[] {
  if (record.location.coordinateSource !== "unknown") return [];

  const basis = UNKNOWN_BIRTHPLACE_BEIJING_BASIS_V1;
  const issues: UnknownBirthplaceBasisIssue[] = [];
  if (record.location.label !== basis.label) {
    issues.push(issue("location.label", `出生地未知必须使用固定标签“${basis.label}”`));
  }
  if (record.location.countryCode !== basis.countryCode) {
    issues.push(issue("location.countryCode", "出生地未知暂算仅适用于 CN 记录"));
  }
  if (record.location.latitude !== undefined) {
    issues.push(issue("location.latitude", "出生地未知不得填写伪造纬度"));
  }
  if (record.location.longitude !== basis.longitude) {
    issues.push(issue("location.longitude", "出生地未知暂算必须使用东经 120° 北京时间基准经线"));
  }
  if (record.location.timeZone !== basis.timeZone) {
    issues.push(issue("location.timeZone", "出生地未知暂算必须使用 Asia/Shanghai 保留历史夏令时"));
  }
  if (record.location.standardOffsetMinutes !== basis.standardOffsetMinutes) {
    issues.push(issue("location.standardOffsetMinutes", "出生地未知暂算必须记录标准偏移 480 分钟"));
  }
  if (record.location.clockConvention !== basis.clockConvention) {
    issues.push(issue("location.clockConvention", "出生地未知暂算必须明确为北京时间口径"));
  }
  if (record.policy.trueSolar !== basis.trueSolar) {
    issues.push(issue("policy.trueSolar", "出生地未知时禁止计算真太阳时"));
  }
  if (record.policy.dst !== basis.dst) {
    issues.push(issue("policy.dst", "出生地未知暂算必须按锁定 IANA 历史时区资料处理夏令时"));
  }
  return issues;
}

export function classifyUnknownBirthplaceBasis(
  record: BirthRecordV1
): UnknownBirthplaceBasisClassification {
  if (record.location.coordinateSource !== "unknown") return "not_unknown";
  return unknownBirthplaceBasisIssues(record).length === 0 ? "valid_basis" : "invalid_basis";
}
