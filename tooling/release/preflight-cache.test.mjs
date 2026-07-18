import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { obsoletePreflightVolumes, preflightStoreVolume } from "./preflight-cache.mjs";

describe("preflight download cache", () => {
  it("binds the store identity to platform, lockfile, and preflight image", () => {
    assert.equal(
      preflightStoreVolume({ architecture: "arm64", lockHash: "lock", imageHash: "image" }),
      "pi-suite-pnpm-arm64-lock-image",
    );
  });

  it("selects only obsolete unreferenced Suite stores", () => {
    assert.deepEqual(
      obsoletePreflightVolumes({
        volumeNames: [
          "other-volume",
          "pi-suite-pnpm-arm64-old-b",
          "pi-suite-pnpm-arm64-current-image",
          "pi-suite-pnpm-arm64-old-a",
          "pi-suite-pnpm-arm64-in-use",
        ],
        currentVolume: "pi-suite-pnpm-arm64-current-image",
        referencedVolumes: new Set(["pi-suite-pnpm-arm64-in-use"]),
      }),
      ["pi-suite-pnpm-arm64-old-a", "pi-suite-pnpm-arm64-old-b"],
    );
  });
});
