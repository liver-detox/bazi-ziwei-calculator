import type { ApiDownload } from "./api.js";

export type ExportSaveResult = "download_started";

export interface ChartDocumentBrowserSeam {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  clickDownload(url: string, filename: string): void;
}

const SAFE_FILENAME = /^bazi-ziwei-chart-\d{8}-\d{4}\.json$/u;

function assertChartDocumentDownload(download: ApiDownload): void {
  if (!SAFE_FILENAME.test(download.filename) || !/^application\/json(?:;|$)/iu.test(download.blob.type)) {
    throw new Error("JSON 文件名或内容类型无效");
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
    }
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
