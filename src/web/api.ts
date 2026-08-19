export interface RuntimeConfig {
  sessionToken: string;
}

declare global {
  var __CYBER_SAGA_RUNTIME__: RuntimeConfig | undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

const PROVIDED_TIME_PATH_TO_FIELD: Readonly<Record<string, string>> = Object.freeze({
  "birthRecord.gender": "gender",
  "birthRecord.calendar.date": "date",
  "birthRecord.providedTime.localTime": "localTime",
  "birthRecord.providedTime.basis": "timeBasis",
  targetYears: "targetYears"
});

export function providedTimeFieldErrors(reason: unknown): Record<string, string> {
  if (reason instanceof ApiError && typeof reason.detail === "object" && reason.detail !== null) {
    const detail = reason.detail as { error?: unknown; issues?: unknown };
    if (detail.error === "PROVIDED_TIME_NO_VALID_CANDIDATE") {
      return { date: "这个日期与时间没有可用的排盘候选，请检查历法和日期" };
    }
    if (detail.error === "INVALID_PROVIDED_TIME_INPUT" && Array.isArray(detail.issues)) {
      const errors: Record<string, string> = {};
      for (const issue of detail.issues) {
        if (typeof issue !== "object" || issue === null) continue;
        const path = String((issue as { path?: unknown }).path ?? "");
        const message = String((issue as { message?: unknown }).message ?? "输入格式不正确");
        const field = PROVIDED_TIME_PATH_TO_FIELD[path];
        if (field !== undefined && errors[field] === undefined) errors[field] = message;
      }
      return Object.keys(errors).length === 0
        ? { form: "请检查性别、出生日期、出生时间和时间口径" }
        : errors;
    }
  }
  if (reason instanceof Error) {
    const field = [
      ["请选择性别", "gender"],
      ["出生日期", "date"],
      ["出生时间", "localTime"],
      ["时间口径", "timeBasis"],
      ["目标流年", "targetYears"]
    ].find(([message]) => reason.message.includes(message))?.[1];
    return field === undefined ? {} : { [field]: reason.message };
  }
  return {};
}

function authorizedRequestOptions(options: RequestInit): RequestInit {
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const token = globalThis.__CYBER_SAGA_RUNTIME__?.sessionToken;
    if (token === undefined) {
      throw new ApiError(0, "本次启动令牌不可用，请从一键启动入口重新打开。", null);
    }
    headers.set("x-cyber-session-token", token);
  }
  return { ...options, method, headers, credentials: "same-origin" };
}

function responseMessage(status: number, detail: unknown): string {
  return typeof detail === "object" && detail !== null && "message" in detail
    ? String((detail as { message: unknown }).message)
    : `本地请求失败（${status}）`;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, authorizedRequestOptions(options));
  const contentType = response.headers.get("content-type") ?? "";
  const detail: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw new ApiError(response.status, responseMessage(response.status, detail), detail);
  }
  return detail as T;
}

export interface ApiDownload {
  blob: Blob;
  filename: string;
}

const SAFE_CHART_DOCUMENT_ATTACHMENT = /^attachment;\s*filename="(bazi-ziwei-chart-\d{8}-\d{4}\.json)"$/iu;

export async function apiJsonDownload(path: string, options: RequestInit = {}): Promise<ApiDownload> {
  const response = await fetch(path, authorizedRequestOptions(options));
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const detail: unknown = contentType.includes("application/json") ? await response.json() : null;
    throw new ApiError(response.status, responseMessage(response.status, detail), detail);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(SAFE_CHART_DOCUMENT_ATTACHMENT)?.[1];
  if (filename === undefined || !/^application\/json(?:;|$)/iu.test(contentType)) {
    throw new ApiError(0, "本地服务返回了无效的 JSON 排盘文件。", null);
  }
  return { blob: await response.blob(), filename };
}
