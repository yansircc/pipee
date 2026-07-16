import { expect, it, vi } from "vite-plus/test";
import { withPostActionVerification } from "../../src/browser/platform-page.js";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const params = {
  tab: resolvedTabFixture(7, 1),
  foreground: false,
  includeSnapshot: true,
} as const;

it("keeps the action receipt when post-action observation fails", async () => {
  const observe = vi.fn(async () => {
    throw new Error("page changed during snapshot");
  });

  await expect(
    withPostActionVerification(params, async () => ({ input: "chrome", clicked: true }), observe),
  ).resolves.toEqual({
    action: { input: "chrome", clicked: true },
    verification: { status: "unavailable", reason: "page changed during snapshot" },
  });
});

it("returns one discriminated result when observation succeeds or is not requested", async () => {
  const observe = vi.fn(async () => ({ mode: "auto", actions: [] }));

  await expect(
    withPostActionVerification(params, async () => ({ input: "chrome" }), observe),
  ).resolves.toEqual({
    action: { input: "chrome" },
    verification: {
      status: "observed",
      snapshot: { mode: "auto", actions: [] },
    },
  });
  await expect(
    withPostActionVerification(
      { ...params, includeSnapshot: false },
      async () => ({ input: "chrome" }),
      observe,
    ),
  ).resolves.toEqual({
    action: { input: "chrome" },
    verification: { status: "not-requested" },
  });
  expect(observe).toHaveBeenCalledTimes(1);
});
