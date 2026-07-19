import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { ChromeWebAction, projectChromeWebView } from "../../src/pi/web-surface.js";

describe("Chrome Web Surface algebra", () => {
  it("admits only supervision and idle-resource cleanup actions", () => {
    expect(Schema.decodeUnknownSync(ChromeWebAction)({ _tag: "Close", tabId: 42 })).toEqual({
      _tag: "Close",
      tabId: 42,
    });
    expect(() =>
      Schema.decodeUnknownSync(ChromeWebAction)({ _tag: "Navigate", url: "https://x" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ChromeWebAction)({ _tag: "Snapshot", tabId: 42 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ChromeWebAction)({ _tag: "NewTab", url: "https://x" }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(ChromeWebAction)({ _tag: "Terminate" })).toEqual({
      _tag: "Terminate",
    });
  });

  it("projects bounded receipts and session-owned tabs", () => {
    expect(
      projectChromeWebView(
        {
          kind: "pi-chrome/status",
          version: 3,
          state: "ready",
          bridge: "running",
          extensionDirectory: "/extension",
        },
        [{ id: 42, active: true, title: "Pi", url: "https://example.com" }],
        [{ at: 1, operation: "chrome_snapshot", tabId: 42, result: "completed" }],
        { operation: "chrome_snapshot", startedAt: 1 },
        [{ at: 1, operation: "chrome_snapshot", phase: "started" }],
      ),
    ).toMatchObject({
      tabs: [{ id: 42 }],
      receipts: [{ operation: "chrome_snapshot" }],
      activity: { operation: "chrome_snapshot" },
      events: [{ phase: "started" }],
    });
  });
});
