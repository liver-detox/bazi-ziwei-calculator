import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiChartDocument } from "../src/web/api.js";
import type { ChartDocumentTextView } from "../src/web/chart-document-text.js";
import {
  copyChartDocumentText,
  printChartDocumentText,
  saveChartDocumentTextDownload,
  shareChartDocumentText,
  type ChartDocumentBrowserSeam,
  type ExportActionResult
} from "../src/web/export-download.js";
import {
  resolveChartDocumentText,
  runExportAction,
  runPreparedExportAction,
  startChartDocumentTextPreparation,
  type ChartDocumentTextPreparationUpdate
} from "../src/web/export-orchestration.js";

const filename = "bazi-ziwei-chart-20260819-0830.json";
const apiResult = { filename, document: { schemaVersion: 1 } } as unknown as ApiChartDocument;

function lifecycle() {
  return {
    setBusy: vi.fn(),
    setError: vi.fn(),
    setStatus: vi.fn()
  };
}

function present(_value: ApiChartDocument["document"], name: string): ChartDocumentTextView {
  return {
    title: "八字与紫微斗数双轨排盘",
    filename: name.replace(/\.json$/u, ".txt"),
    contentType: "text/plain; charset=utf-8",
    plainText: "# 八字与紫微斗数双轨排盘\n"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settlePreparation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function browserSeam(): ChartDocumentBrowserSeam {
  return {
    createObjectURL: vi.fn(() => "blob:chart-document"),
    revokeObjectURL: vi.fn(),
    clickDownload: vi.fn(),
    writeClipboardText: vi.fn(async () => {}),
    supportsShare: vi.fn(() => true),
    canShare: vi.fn(() => false),
    share: vi.fn(async () => {}),
    print: vi.fn(),
    getPageTitle: vi.fn(() => "合成页面标题"),
    setPageTitle: vi.fn()
  };
}

describe("chart document export orchestration", () => {
  it("prepares one keyed text view through one request and reports real state transitions", async () => {
    const pending = deferred<ApiChartDocument>();
    const request = vi.fn(() => pending.promise);
    const updates: ChartDocumentTextPreparationUpdate[] = [];

    startChartDocumentTextPreparation({
      key: "CS-1991-001:R001:candidate-a:2026",
      request,
      present,
      onUpdate: (update) => updates.push(update)
    });

    expect(request).toHaveBeenCalledOnce();
    expect(updates).toEqual([{
      status: "preparing",
      key: "CS-1991-001:R001:candidate-a:2026"
    }]);

    pending.resolve(apiResult);
    await settlePreparation();
    expect(updates).toEqual([
      { status: "preparing", key: "CS-1991-001:R001:candidate-a:2026" },
      {
        status: "ready",
        key: "CS-1991-001:R001:candidate-a:2026",
        view: present(apiResult.document, apiResult.filename)
      }
    ]);
  });

  it("cancels an invalidated preparation so its late result cannot replace the next key", async () => {
    const oldPending = deferred<ApiChartDocument>();
    const nextPending = deferred<ApiChartDocument>();
    const readyFilenames: string[] = [];
    const oldPreparation = startChartDocumentTextPreparation({
      key: "old-key",
      request: () => oldPending.promise,
      present,
      onUpdate: (update) => {
        if (update.status === "ready") readyFilenames.push(update.view.filename);
      }
    });

    oldPreparation.cancel();
    startChartDocumentTextPreparation({
      key: "next-key",
      request: () => nextPending.promise,
      present,
      onUpdate: (update) => {
        if (update.status === "ready") readyFilenames.push(update.view.filename);
      }
    });
    nextPending.resolve({ ...apiResult, filename: "bazi-ziwei-chart-20260819-0831.json" });
    await settlePreparation();
    oldPending.resolve(apiResult);
    await settlePreparation();

    expect(readyFilenames).toEqual(["bazi-ziwei-chart-20260819-0831.txt"]);
  });

  it("maps an untrusted preparation error to the localized fallback without publishing a ready view", async () => {
    const updates: ChartDocumentTextPreparationUpdate[] = [];

    startChartDocumentTextPreparation({
      key: "failed-key",
      request: async () => { throw new TypeError("Failed to fetch"); },
      present,
      onUpdate: (update) => updates.push(update)
    });
    await settlePreparation();

    expect(updates).toEqual([
      { status: "preparing", key: "failed-key" },
      {
        status: "failed",
        key: "failed-key",
        error: "暂时无法准备 AI 文本，请确认本地程序仍在运行后重试。"
      }
    ]);
  });

  it("preserves a localized API preparation error", async () => {
    const updates: ChartDocumentTextPreparationUpdate[] = [];

    startChartDocumentTextPreparation({
      key: "api-failed-key",
      request: async () => { throw new ApiError(422, "排盘资料校验失败", null); },
      present,
      onUpdate: (update) => updates.push(update)
    });
    await settlePreparation();

    expect(updates).toEqual([
      { status: "preparing", key: "api-failed-key" },
      { status: "failed", key: "api-failed-key", error: "排盘资料校验失败" }
    ]);
  });

  it("allows the same key to retry once after failure and become ready", async () => {
    const updates: ChartDocumentTextPreparationUpdate[] = [];
    const request = vi.fn()
      .mockRejectedValueOnce("blocked")
      .mockResolvedValueOnce(apiResult);
    const prepare = () => startChartDocumentTextPreparation({
      key: "same-key",
      request,
      present,
      fallbackError: "文本导出准备失败",
      onUpdate: (update) => updates.push(update)
    });

    prepare();
    await settlePreparation();
    prepare();
    await settlePreparation();

    expect(request).toHaveBeenCalledTimes(2);
    expect(updates.map((update) => update.status)).toEqual([
      "preparing",
      "failed",
      "preparing",
      "ready"
    ]);
    expect(updates[1]).toEqual({ status: "failed", key: "same-key", error: "文本导出准备失败" });
  });

  it("starts a browser action from an already prepared view before returning to the caller", async () => {
    const events: string[] = [];
    let finish: ((result: ExportActionResult) => void) | undefined;
    const actionResult = new Promise<ExportActionResult>((resolve) => { finish = resolve; });
    const running = runPreparedExportAction({
      view: present(apiResult.document, apiResult.filename),
      action: (view) => {
        events.push(`action:${view.filename}`);
        return actionResult;
      },
      lifecycle: {
        setBusy: (value) => events.push(`busy:${value}`),
        setError: (value) => events.push(`error:${value}`),
        setStatus: (value) => events.push(`status:${value}`)
      },
      fallbackError: "导出失败"
    });

    expect(events).toEqual([
      "busy:true",
      "error:",
      "status:",
      "action:bazi-ziwei-chart-20260819-0830.txt"
    ]);
    finish?.("copied");
    await running;
    expect(events.at(-2)).toBe("status:copied");
    expect(events.at(-1)).toBe("busy:false");
  });

  it("runs request, presentation, lifecycle, and action callbacks once in their complete order", async () => {
    const events: string[] = [];
    const request = vi.fn(async () => { events.push("request"); return apiResult; });
    const presenter = vi.fn((_value: ApiChartDocument["document"], name: string) => {
      events.push("present");
      return present(_value, name);
    });
    const action = vi.fn(async () => { events.push("action"); return "copied" as const; });
    const view = await resolveChartDocumentText({
      request,
      present: presenter
    });

    await runExportAction({
      action,
      lifecycle: {
        setBusy: (value) => events.push(`busy:${value}`),
        setError: (value) => events.push(`error:${value}`),
        setStatus: (value) => events.push(`status:${value}`)
      },
      fallbackError: "复制失败"
    });

    expect(events).toEqual([
      "request",
      "present",
      "busy:true",
      "error:",
      "status:",
      "action",
      "status:copied",
      "busy:false"
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(presenter).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
    expect(view.filename).toBe("bazi-ziwei-chart-20260819-0830.txt");
  });

  it.each<[
    string,
    ExportActionResult,
    (view: ChartDocumentTextView, browser: ChartDocumentBrowserSeam) => Promise<ExportActionResult>
  ]>([
    ["复制", "copied", (view, browser) => copyChartDocumentText({ view, browser })],
    ["下载 TXT", "download_started", async (view, browser) => saveChartDocumentTextDownload({ view, browser })],
    ["系统分享", "shared", (view, browser) => shareChartDocumentText({ view, browser })],
    ["打印", "print_started", (view, browser) => printChartDocumentText({ view, browser, reveal: vi.fn(), conceal: vi.fn() })]
  ])("runs the %s browser action from one already prepared ChartDocument view", async (_label, expected, perform) => {
    const request = vi.fn(async () => apiResult);
    const state = lifecycle();
    const view = await resolveChartDocumentText({ request, present });

    await runPreparedExportAction({
      view,
      action: (prepared) => perform(prepared, browserSeam()),
      lifecycle: state,
      fallbackError: "导出失败"
    });

    expect(request).toHaveBeenCalledOnce();
    expect(state.setStatus.mock.calls).toEqual([[""], [expected]]);
  });

  it("preserves a request error message and always restores the lifecycle", async () => {
    const state = lifecycle();

    await runExportAction({
      action: async () => resolveChartDocumentText({
        request: async () => { throw new Error("排盘资料读取失败"); }
      }).then(() => "copied"),
      lifecycle: state,
      fallbackError: "复制失败"
    });

    expect(state.setError.mock.calls).toEqual([[""], ["排盘资料读取失败"]]);
    expect(state.setStatus.mock.calls).toEqual([[""]]);
    expect(state.setBusy.mock.calls).toEqual([[true], [false]]);
  });

  it("uses the fixed fallback for a non-Error action failure and restores busy", async () => {
    const state = lifecycle();

    await runExportAction({
      action: async () => { throw "blocked"; },
      lifecycle: state,
      fallbackError: "打印失败"
    });

    expect(state.setError.mock.calls).toEqual([[""], ["打印失败"]]);
    expect(state.setStatus.mock.calls).toEqual([[""]]);
    expect(state.setBusy.mock.calls).toEqual([[true], [false]]);
  });
});
