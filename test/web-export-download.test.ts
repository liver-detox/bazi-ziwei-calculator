import { afterEach, describe, expect, it, vi } from "vitest";

import { apiChartDocument, apiJsonDownload, ApiError } from "../src/web/api.js";
import {
  copyChartDocumentText,
  saveChartDocumentDownload,
  saveChartDocumentTextDownload,
  shareChartDocumentText,
  printChartDocumentText,
  supportsChartDocumentShare,
  type ChartDocumentBrowserSeam
} from "../src/web/export-download.js";
import type { ChartDocumentTextView } from "../src/web/chart-document-text.js";

const originalFetch = globalThis.fetch;
const originalRuntime = globalThis.__CYBER_SAGA_RUNTIME__;
const filename = "bazi-ziwei-chart-20260813-0630.json";
const renderedChartText: ChartDocumentTextView = {
  title: "八字与紫微斗数双轨排盘",
  filename: "bazi-ziwei-chart-20260819-0830.txt",
  contentType: "text/plain; charset=utf-8",
  plainText: "# 八字与紫微斗数双轨排盘\n- 目标流年：2026"
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.__CYBER_SAGA_RUNTIME__ = originalRuntime;
  vi.restoreAllMocks();
});

function download(overrides: Partial<{ filename: string; blob: Blob }> = {}) {
  return {
    filename,
    blob: new Blob([JSON.stringify({ schemaVersion: "1.0.0" })], { type: "application/json" }),
    ...overrides
  };
}

function browserSeam(overrides: Partial<ChartDocumentBrowserSeam> = {}): ChartDocumentBrowserSeam {
  return {
    createObjectURL: vi.fn(() => "blob:chart-document"),
    revokeObjectURL: vi.fn(),
    clickDownload: vi.fn(),
    writeClipboardText: vi.fn(async () => {}),
    supportsShare: vi.fn(() => true),
    canShare: vi.fn(() => false),
    share: vi.fn(async () => {}),
    print: vi.fn(),
    getPageTitle: vi.fn(() => "赛博大师·八字与紫微斗数排盘计算器"),
    setPageTitle: vi.fn(),
    ...overrides
  };
}

describe("authenticated chart document download", () => {
  it("reads one safe authenticated JSON attachment as a ChartDocument object", async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      schemaVersion: 1,
      calculatorVersion: "0.2.0"
    }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`
      }
    }));
    globalThis.fetch = fetchStub as typeof fetch;
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };

    const result = await apiChartDocument("/api/cases/CS-1991-001/revisions/R001/chart-document", {
      method: "POST",
      body: JSON.stringify({ candidateId: "candidate-a", targetYear: 2026 })
    });

    expect(result.filename).toBe(filename);
    expect(result.document).toMatchObject({ schemaVersion: 1, calculatorVersion: "0.2.0" });
    const [, request] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(request.headers).get("x-cyber-session-token"))
      .toBe("s".repeat(43));
  });

  it("rejects invalid attachment metadata as an ApiError", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-disposition": "attachment; filename=../../private.json"
      }
    })) as typeof fetch;

    await expect(apiChartDocument("/download", { method: "POST" }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it("rejects non-JSON attachments as an ApiError", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response("{}", {
      headers: {
        "content-type": "text/plain",
        "content-disposition": `attachment; filename="${filename}"`
      }
    })) as typeof fetch;

    await expect(apiChartDocument("/download", { method: "POST" }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an unparsable attachment body as an ApiError", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response("not json", {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${filename}"`
      }
    })) as typeof fetch;

    await expect(apiChartDocument("/download", { method: "POST" }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it("rejects non-ChartDocument JSON as an ApiError without returning partial data", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 2 }), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${filename}"`
      }
    })) as typeof fetch;

    await expect(apiChartDocument("/download", { method: "POST" }))
      .rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", JSON.stringify("x")]
  ])("rejects %s JSON without returning partial data", async (_label, body) => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${filename}"`
      }
    })) as typeof fetch;

    const request = apiChartDocument("/download", { method: "POST" });
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      message: "本地服务返回了无法读取的排盘数据。"
    });
  });

  it("preserves a server JSON error message as an ApiError", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: "排盘资料校验失败" }), {
      status: 422,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

    await expect(apiChartDocument("/download", { method: "POST" }))
      .rejects.toMatchObject({ name: "ApiError", message: "排盘资料校验失败", status: 422 });
  });

  it("sends the local session token and accepts one safe JSON attachment", async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: "1.0.0" }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`
      }
    }));
    globalThis.fetch = fetchStub as typeof fetch;
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };

    const result = await apiJsonDownload("/api/cases/CS-1991-001/revisions/R001/chart-document", {
      method: "POST",
      body: JSON.stringify({ candidateId: "candidate-a", targetYear: 2026 })
    });

    expect(result.filename).toBe(filename);
    expect(result.blob.type).toMatch(/^application\/json(?:;|$)/u);
    expect(await result.blob.text()).toContain("schemaVersion");
    const [, request] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(request.headers).get("x-cyber-session-token")).toBe("s".repeat(43));
    expect(new Headers(request.headers).get("content-type")).toBe("application/json");
  });

  it("rejects unsafe names, non-JSON responses, and preserves JSON server messages", async () => {
    globalThis.__CYBER_SAGA_RUNTIME__ = { sessionToken: "s".repeat(43) };
    globalThis.fetch = vi.fn(async () => new Response("not json", {
      headers: {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=../../private.json"
      }
    })) as typeof fetch;
    await expect(apiJsonDownload("/download", { method: "POST" })).rejects.toMatchObject({ name: "ApiError" });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: "排盘资料校验失败" }), {
      status: 422,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
    await expect(apiJsonDownload("/download", { method: "POST" }))
      .rejects.toMatchObject({ message: "排盘资料校验失败", status: 422 });
  });
});

describe("single chart document browser download", () => {
  it("starts one download and always revokes its object URL", async () => {
    const browser = browserSeam();
    const request = vi.fn(async () => download());

    await expect(saveChartDocumentDownload({ request, browser })).resolves.toBe("download_started");

    expect(request).toHaveBeenCalledOnce();
    expect(browser.createObjectURL).toHaveBeenCalledOnce();
    expect(browser.clickDownload).toHaveBeenCalledTimes(1);
    expect(browser.clickDownload).toHaveBeenCalledWith("blob:chart-document", filename);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:chart-document");
  });

  it("rejects a dangerous name or non-JSON blob before creating a download", async () => {
    const browser = browserSeam();

    await expect(saveChartDocumentDownload({
      browser,
      request: async () => download({ filename: "../../private.json" })
    })).rejects.toThrow("JSON 文件名或内容类型无效");
    await expect(saveChartDocumentDownload({
      browser,
      request: async () => download({ blob: new Blob(["not json"], { type: "text/plain" }) })
    })).rejects.toThrow("JSON 文件名或内容类型无效");
    expect(browser.createObjectURL).not.toHaveBeenCalled();
    expect(browser.clickDownload).not.toHaveBeenCalled();
  });

  it("revokes the object URL when the browser click fails", async () => {
    const browser = browserSeam({ clickDownload: vi.fn(() => { throw new Error("download blocked"); }) });

    await expect(saveChartDocumentDownload({ browser, request: async () => download() }))
      .rejects.toThrow("download blocked");
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:chart-document");
  });
});

describe("rendered chart text browser actions", () => {
  it("requests system print in the initiating call stack once the prepared text is revealed", async () => {
    const calls: string[] = [];
    const browser = browserSeam({
      print: vi.fn(() => { calls.push("print"); })
    });
    const running = printChartDocumentText({
      view: renderedChartText,
      reveal: () => { calls.push("reveal"); },
      conceal: () => { calls.push("conceal"); },
      browser
    });

    expect(calls.slice(0, 2)).toEqual(["reveal", "print"]);
    await running;
    expect(calls.at(-1)).toBe("conceal");
  });

  it("downloads rendered chart text and always revokes its object URL", async () => {
    const browser = browserSeam();

    expect(saveChartDocumentTextDownload({ view: renderedChartText, browser })).toBe("download_started");
    expect(browser.clickDownload).toHaveBeenCalledWith("blob:chart-document", renderedChartText.filename);
    expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:chart-document");
    const downloadedBlob = vi.mocked(browser.createObjectURL).mock.calls[0]?.[0];
    expect(downloadedBlob?.type).toBe("text/plain; charset=utf-8");
    await expect(downloadedBlob?.text()).resolves.toBe(renderedChartText.plainText);

    const blockingBrowser = browserSeam({ clickDownload: vi.fn(() => { throw new Error("download blocked"); }) });
    expect(() => saveChartDocumentTextDownload({ view: renderedChartText, browser: blockingBrowser }))
      .toThrow("download blocked");
    expect(blockingBrowser.revokeObjectURL).toHaveBeenCalledWith("blob:chart-document");
  });

  it("copies the exact rendered chart text through the clipboard seam", async () => {
    const browser = browserSeam();

    await expect(copyChartDocumentText({ view: renderedChartText, browser })).resolves.toBe("copied");

    expect(browser.writeClipboardText).toHaveBeenCalledWith(renderedChartText.plainText);
  });

  it("shares a rendered chart text file before falling back to the same plain text", async () => {
    const fileBrowser = browserSeam({ canShare: vi.fn((data: ShareData) => data.files !== undefined) });

    await expect(shareChartDocumentText({ view: renderedChartText, browser: fileBrowser })).resolves.toBe("shared");

    const fileShare = vi.mocked(fileBrowser.share).mock.calls[0]?.[0];
    expect(fileShare?.title).toBe(renderedChartText.title);
    const file = fileShare?.files?.[0];
    expect(file?.name).toBe(renderedChartText.filename);
    expect(file?.type).toBe(renderedChartText.contentType);
    await expect(file?.text()).resolves.toBe(renderedChartText.plainText);

    const plainTextBrowser = browserSeam({ canShare: vi.fn(() => false) });
    await expect(shareChartDocumentText({ view: renderedChartText, browser: plainTextBrowser })).resolves.toBe("shared");
    expect(plainTextBrowser.share).toHaveBeenCalledWith({
      title: renderedChartText.title,
      text: renderedChartText.plainText
    });
  });

  it("returns unavailable without an implicit fallback when Web Share is absent", async () => {
    const browser = browserSeam({ supportsShare: vi.fn(() => false) });

    expect(supportsChartDocumentShare(browser)).toBe(false);
    await expect(shareChartDocumentText({ view: renderedChartText, browser })).resolves.toBe("share_unavailable");

    expect(browser.clickDownload).not.toHaveBeenCalled();
    expect(browser.writeClipboardText).not.toHaveBeenCalled();
    expect(browser.share).not.toHaveBeenCalled();
  });

  it("treats an aborted share as cancellation and rethrows other share errors", async () => {
    const cancellationBrowser = browserSeam({
      share: vi.fn(async () => { throw new DOMException("cancelled", "AbortError"); })
    });
    await expect(shareChartDocumentText({ view: renderedChartText, browser: cancellationBrowser }))
      .resolves.toBe("share_cancelled");

    const crossRealmAbort = new Error("cancelled");
    crossRealmAbort.name = "AbortError";
    const crossRealmCancellationBrowser = browserSeam({
      share: vi.fn(async () => { throw crossRealmAbort; })
    });
    await expect(shareChartDocumentText({ view: renderedChartText, browser: crossRealmCancellationBrowser }))
      .resolves.toBe("share_cancelled");

    const failure = new Error("share blocked");
    const failingBrowser = browserSeam({ share: vi.fn(async () => { throw failure; }) });
    await expect(shareChartDocumentText({ view: renderedChartText, browser: failingBrowser }))
      .rejects.toBe(failure);
  });

  it("prints prepared chart text after synchronous reveal and always conceals it", async () => {
    const calls: string[] = [];
    const browser = browserSeam({
      getPageTitle: vi.fn(() => {
        calls.push("get-title");
        return "赛博大师·八字与紫微斗数排盘计算器";
      }),
      setPageTitle: vi.fn((title: string) => { calls.push(`set-title:${title}`); }),
      print: vi.fn(() => { calls.push("print"); })
    });
    const reveal = vi.fn((text: string) => { calls.push(`reveal:${text}`); });
    const conceal = vi.fn(() => { calls.push("conceal"); });

    await expect(printChartDocumentText({ view: renderedChartText, reveal, conceal, browser }))
      .resolves.toBe("print_started");
    expect(calls).toEqual([
      "get-title",
      "set-title:bazi-ziwei-chart-20260819-0830",
      `reveal:${renderedChartText.plainText}`,
      "print",
      "conceal",
      "set-title:赛博大师·八字与紫微斗数排盘计算器"
    ]);

    const printError = new Error("print blocked");
    const printTitles: string[] = [];
    const printBrowser = browserSeam({
      getPageTitle: vi.fn(() => "original print title"),
      setPageTitle: vi.fn((title: string) => { printTitles.push(title); }),
      print: vi.fn(() => { throw printError; })
    });
    const printConceal = vi.fn();
    await expect(printChartDocumentText({
      view: renderedChartText,
      reveal: vi.fn(),
      conceal: printConceal,
      browser: printBrowser
    })).rejects.toBe(printError);
    expect(printConceal).toHaveBeenCalledOnce();
    expect(printTitles).toEqual([
      "bazi-ziwei-chart-20260819-0830",
      "original print title"
    ]);
  });
});
