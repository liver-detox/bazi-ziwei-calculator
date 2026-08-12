export interface LocalBrowserOpenCommand {
  command: string;
  args: string[];
}

interface LocalBrowserOpenProcess {
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

const LOCAL_URL_ERROR = "只允许打开本机地址";
const LOCAL_BROWSER_OPEN_ERROR = "无法自动打开浏览器，请复制上方本机地址手动打开。";

export function localBrowserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
  disabled: boolean
): LocalBrowserOpenCommand | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(LOCAL_URL_ERROR);
  }

  const localPort = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]+)(?:[/?#]|$)/.exec(url)?.[1];
  const port = Number(localPort);
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    localPort === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(LOCAL_URL_ERROR);
  }

  if (disabled || platform !== "darwin") {
    return null;
  }

  return { command: "/usr/bin/open", args: [url] };
}

export function monitorLocalBrowserOpen(
  child: LocalBrowserOpenProcess,
  reportFailure: (message: string) => void
): void {
  child.once("error", () => {
    reportFailure(LOCAL_BROWSER_OPEN_ERROR);
  });
  child.unref();
}
