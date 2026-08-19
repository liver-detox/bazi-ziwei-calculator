import type { ApiDownload } from "./api.js";
import type { ChartDocumentTextView } from "./chart-document-text.js";

export type ExportSaveResult = "download_started";
export type ExportActionResult =
  | "download_started"
  | "copied"
  | "shared"
  | "share_unavailable"
  | "share_cancelled"
  | "print_started";

export interface ChartDocumentBrowserSeam {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  clickDownload(url: string, filename: string): void;
  writeClipboardText(text: string): Promise<void>;
  supportsShare(): boolean;
  canShare(data: ShareData): boolean;
  share(data: ShareData): Promise<void>;
  print(): void;
  getPageTitle(): string;
  setPageTitle(title: string): void;
}

const SAFE_FILENAME = /^bazi-ziwei-chart-\d{8}-\d{4}\.json$/u;
const SAFE_TEXT_FILENAME = /^bazi-ziwei-chart-\d{8}-\d{4}\.txt$/u;
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

function assertChartDocumentDownload(download: ApiDownload): void {
  if (!SAFE_FILENAME.test(download.filename) || !/^application\/json(?:;|$)/iu.test(download.blob.type)) {
    throw new Error("JSON 文件名或内容类型无效");
  }
}

function assertChartDocumentTextDownload(view: ChartDocumentTextView): void {
  if (!SAFE_TEXT_FILENAME.test(view.filename) || view.contentType !== TEXT_CONTENT_TYPE) {
    throw new Error("TXT 文件名或内容类型无效");
  }
}

function defaultBrowserSeam(): ChartDocumentBrowserSeam {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    clickDownload: (url, filename) => {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.hidden = true;
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    },
    writeClipboardText: async (text) => {
      if (navigator.clipboard?.writeText === undefined) {
        throw new Error("当前浏览器不能直接复制，请下载 TXT 文件。");
      }
      await navigator.clipboard.writeText(text);
    },
    supportsShare: () => typeof navigator.share === "function",
    canShare: (data) => typeof navigator.canShare === "function" && navigator.canShare(data),
    share: async (data) => {
      if (typeof navigator.share !== "function") {
        throw new Error("当前浏览器不支持系统分享。");
      }
      await navigator.share(data);
    },
    print: () => window.print(),
    getPageTitle: () => document.title,
    setPageTitle: (title) => { document.title = title; }
  };
}

export async function saveChartDocumentDownload(input: {
  request: () => Promise<ApiDownload>;
  browser?: ChartDocumentBrowserSeam;
}): Promise<ExportSaveResult> {
  const download = await input.request();
  assertChartDocumentDownload(download);
  const browser = input.browser ?? defaultBrowserSeam();
  const url = browser.createObjectURL(download.blob);
  try {
    browser.clickDownload(url, download.filename);
  } finally {
    browser.revokeObjectURL(url);
  }
  return "download_started";
}

export function saveChartDocumentTextDownload(input: {
  view: ChartDocumentTextView;
  browser?: ChartDocumentBrowserSeam;
}): ExportActionResult {
  assertChartDocumentTextDownload(input.view);
  const browser = input.browser ?? defaultBrowserSeam();
  const url = browser.createObjectURL(new Blob([input.view.plainText], { type: input.view.contentType }));
  try {
    browser.clickDownload(url, input.view.filename);
  } finally {
    browser.revokeObjectURL(url);
  }
  return "download_started";
}

export async function copyChartDocumentText(input: {
  view: ChartDocumentTextView;
  browser?: ChartDocumentBrowserSeam;
}): Promise<ExportActionResult> {
  const browser = input.browser ?? defaultBrowserSeam();
  await browser.writeClipboardText(input.view.plainText);
  return "copied";
}

export function supportsChartDocumentShare(browser: ChartDocumentBrowserSeam = defaultBrowserSeam()): boolean {
  return browser.supportsShare();
}

export async function shareChartDocumentText(input: {
  view: ChartDocumentTextView;
  browser?: ChartDocumentBrowserSeam;
}): Promise<ExportActionResult> {
  const browser = input.browser ?? defaultBrowserSeam();
  if (!supportsChartDocumentShare(browser)) return "share_unavailable";

  const file = new File([input.view.plainText], input.view.filename, { type: input.view.contentType });
  const fileShare: ShareData = { title: input.view.title, files: [file] };
  const shareData = browser.canShare(fileShare)
    ? fileShare
    : { title: input.view.title, text: input.view.plainText };

  try {
    await browser.share(shareData);
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
      return "share_cancelled";
    }
    throw error;
  }
  return "shared";
}

export async function printChartDocumentText(input: {
  view: ChartDocumentTextView;
  reveal: (text: string) => void;
  conceal: () => void;
  browser?: ChartDocumentBrowserSeam;
}): Promise<ExportActionResult> {
  assertChartDocumentTextDownload(input.view);
  const browser = input.browser ?? defaultBrowserSeam();
  const originalTitle = browser.getPageTitle();
  try {
    browser.setPageTitle(input.view.filename.slice(0, -".txt".length));
    input.reveal(input.view.plainText);
    browser.print();
    return "print_started";
  } finally {
    try {
      input.conceal();
    } finally {
      browser.setPageTitle(originalTitle);
    }
  }
}
