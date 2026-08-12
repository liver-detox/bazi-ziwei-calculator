import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  localBrowserOpenCommand,
  monitorLocalBrowserOpen
} from "../src/server/local-browser-open.js";

describe("localBrowserOpenCommand", () => {
  it("returns the fixed macOS opener for a local IPv4 URL", () => {
    expect(localBrowserOpenCommand("darwin", "http://127.0.0.1:3000", false)).toEqual({
      command: "/usr/bin/open",
      args: ["http://127.0.0.1:3000"]
    });
  });

  it("accepts localhost and the full valid port range", () => {
    expect(localBrowserOpenCommand("darwin", "http://localhost:1", false)).toEqual({
      command: "/usr/bin/open",
      args: ["http://localhost:1"]
    });
    expect(localBrowserOpenCommand("darwin", "http://127.0.0.1:65535/path?view=chart", false)).toEqual({
      command: "/usr/bin/open",
      args: ["http://127.0.0.1:65535/path?view=chart"]
    });
  });

  it.each(["win32", "linux"] as const)("does not auto-open on %s", (platform) => {
    expect(localBrowserOpenCommand(platform, "http://127.0.0.1:3000", false)).toBeNull();
  });

  it("does not auto-open when browser startup is disabled", () => {
    expect(localBrowserOpenCommand("darwin", "http://127.0.0.1:3000", true)).toBeNull();
  });

  it.each([
    "https://example.com:443",
    "http://example.com:3000",
    "https://127.0.0.1:3000",
    "http://127.0.0.1",
    "http://localhost:0",
    "http://localhost:65536",
    "http://[::1]:3000",
    "not a url"
  ])("rejects a non-local or malformed URL: %s", (url) => {
    expect(() => localBrowserOpenCommand("darwin", url, false)).toThrow("只允许打开本机地址");
  });
});

describe("monitorLocalBrowserOpen", () => {
  it("handles a child startup error without throwing after registering before unref", () => {
    class FakeChildProcess extends EventEmitter {
      unrefCalled = false;
      errorHandlerRegisteredBeforeUnref = false;

      unref() {
        this.errorHandlerRegisteredBeforeUnref = this.listenerCount("error") === 1;
        this.unrefCalled = true;
      }
    }

    const child = new FakeChildProcess();
    const messages: string[] = [];

    monitorLocalBrowserOpen(child, (message) => messages.push(message));

    expect(child.errorHandlerRegisteredBeforeUnref).toBe(true);
    expect(child.unrefCalled).toBe(true);
    expect(() => child.emit("error", new Error("sensitive executable detail"))).not.toThrow();
    expect(messages).toEqual(["无法自动打开浏览器，请复制上方本机地址手动打开。"]);
    expect(messages.join(" ")).not.toContain("sensitive executable detail");
  });
});
