import { expect, it } from "vite-plus/test";
import {
  SCREENSHOT_TRANSPORT_BYTE_LIMIT,
  accountScreenshotDataUrl,
} from "../../src/browser/screenshot-transport.js";

it("enforces one cumulative screenshot transport budget", () => {
  const first = "a".repeat(SCREENSHOT_TRANSPORT_BYTE_LIMIT - 1);
  const firstBudget = accountScreenshotDataUrl(0, first);
  expect(firstBudget).toEqual({ ok: true, usedBytes: SCREENSHOT_TRANSPORT_BYTE_LIMIT - 1 });
  if (!firstBudget.ok) throw new Error("expected the first screenshot tile to fit");

  expect(accountScreenshotDataUrl(firstBudget.usedBytes, "b")).toEqual({
    ok: true,
    usedBytes: SCREENSHOT_TRANSPORT_BYTE_LIMIT,
  });
  expect(accountScreenshotDataUrl(firstBudget.usedBytes, "bc")).toEqual({
    ok: false,
    usedBytes: SCREENSHOT_TRANSPORT_BYTE_LIMIT + 1,
    limitBytes: SCREENSHOT_TRANSPORT_BYTE_LIMIT,
  });
});
