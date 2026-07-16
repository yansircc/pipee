import { expect, it } from "vite-plus/test";
import {
  BrowserOutcomeUnknown,
  BrowserRejected,
  makeBrowserFailureResult,
} from "../../src/browser/browser-command-failure.js";

it("maps a read-only rejection to CommandRejected", () => {
  const result = makeBrowserFailureResult(
    "read-only",
    new BrowserRejected("tab.list failed", {
      cause: "query failed",
      code: "ambiguous-owned-target",
      details: { ownedTargets: [{ state: "owned", tabId: 7 }] },
    }),
  );

  expect(result).toEqual({
    id: "read-only",
    ok: false,
    error: {
      _tag: "CommandRejected",
      code: "ambiguous-owned-target",
      message: "tab.list failed",
      details: { ownedTargets: [{ state: "owned", tabId: 7 }] },
    },
  });
});

it("maps timeout and partial mutation failures to CommandOutcomeUnknown", () => {
  const timeout = makeBrowserFailureResult(
    "timeout",
    new BrowserOutcomeUnknown("Browser operation exceeded its deadline", {
      cause: "browser execution deadline exceeded",
    }),
  );
  const partial = makeBrowserFailureResult(
    "partial",
    new BrowserOutcomeUnknown("tab.activate may have changed Chrome", {
      cause: "tab update failed after window focus",
    }),
  );

  expect(timeout).toMatchObject({
    id: "timeout",
    ok: false,
    error: { _tag: "CommandOutcomeUnknown" },
  });
  expect(partial).toMatchObject({
    id: "partial",
    ok: false,
    error: { _tag: "CommandOutcomeUnknown" },
  });
});
