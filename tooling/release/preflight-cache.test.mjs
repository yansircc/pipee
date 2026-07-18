import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { obsoletePreflightVolumes, preflightStoreVolume } from "./preflight-cache.mjs";

describe("preflight download cache", () => {
  it("binds the store identity to platform, lockfile, workspace policy, and image", () => {
    const identity = {
      architecture: "arm64",
      lockHash: "lock",
      workspaceHash: "policy",
      imageHash: "image",
    };
    assert.equal(preflightStoreVolume(identity), "pi-suite-pnpm-arm64-lock-policy-image");
    assert.notEqual(
      preflightStoreVolume(identity),
      preflightStoreVolume({ ...identity, workspaceHash: "changed-policy" }),
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
