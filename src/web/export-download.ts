import type { ApiDownload } from "./api.js";

export type ExportDestination = "downloads" | "choose";
export type ExportSaveResult = "download_started" | "saved" | "cancelled" | "fallback_download";

export interface ExportWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort?: () => Promise<void>;
}

export interface ExportFileHandle {
  createWritable(): Promise<ExportWritable>;
}

export interface ExportBrowserSeam {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  clickDownload(url: string, filename: string): void;
  showSaveFilePicker?: (options: {
    suggestedName: string;
    excludeAcceptAllOption: boolean;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<ExportFileHandle>;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.tar\.gz$/u;

function assertExpectedDownload(download: ApiDownload, filename: string): void {
  if (!SAFE_FILENAME.test(filename) || download.filename !== filename) {
    throw new Error("证据包文件名与当前修订不一致");
  }
}

function defaultBrowserSeam(): ExportBrowserSeam {
  const picker = (globalThis as typeof globalThis & {
    showSaveFilePicker?: ExportBrowserSeam["showSaveFilePicker"];
  }).showSaveFilePicker;
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
    ...(picker === undefined ? {} : { showSaveFilePicker: picker.bind(globalThis) })
  };
}

async function startDefaultDownload(
  filename: string,
  request: () => Promise<ApiDownload>,
  browser: ExportBrowserSeam
): Promise<void> {
  const download = await request();
  assertExpectedDownload(download, filename);
  const url = browser.createObjectURL(download.blob);
  try {
    browser.clickDownload(url, download.filename);
  } finally {
    browser.revokeObjectURL(url);
  }
}

function isPickerCancellation(reason: unknown): boolean {
  return typeof reason === "object" && reason !== null && "name" in reason
    && (reason as { name: unknown }).name === "AbortError";
}

export async function saveEvidenceDownload(input: {
  filename: string;
  destination: ExportDestination;
  request: () => Promise<ApiDownload>;
  browser?: ExportBrowserSeam;
}): Promise<ExportSaveResult> {
  const browser = input.browser ?? defaultBrowserSeam();
  if (input.destination === "downloads") {
    await startDefaultDownload(input.filename, input.request, browser);
    return "download_started";
  }
  if (browser.showSaveFilePicker === undefined) {
    await startDefaultDownload(input.filename, input.request, browser);
    return "fallback_download";
  }
  let handle: ExportFileHandle;
  try {
    handle = await browser.showSaveFilePicker({
      suggestedName: input.filename,
      excludeAcceptAllOption: true,
      types: [{ description: "赛博大师证据包", accept: { "application/gzip": [".tar.gz"] } }]
    });
  } catch (reason) {
    if (isPickerCancellation(reason)) return "cancelled";
    throw reason;
  }
  const download = await input.request();
  assertExpectedDownload(download, input.filename);
  const writable = await handle.createWritable();
  try {
    await writable.write(download.blob);
    await writable.close();
  } catch (reason) {
    try {
      if (writable.abort !== undefined) await writable.abort();
      else await writable.close();
    } catch {
      // Preserve the original write/close failure.
    }
    throw reason;
  }
  return "saved";
}
