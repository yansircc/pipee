import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumpVersion, releaseBumpFromMessage } from "./version.mjs";

describe("Suite release version algebra", () => {
  it("defaults a source push to patch", () => {
    assert.equal(releaseBumpFromMessage("fix: repair runtime"), "patch");
    assert.equal(bumpVersion("0.5.7", "patch"), "0.5.8");
  });

  it("accepts one explicit minor or major trailer", () => {
    assert.equal(releaseBumpFromMessage("feat: suite\n\nRelease-Bump: minor"), "minor");
    assert.equal(bumpVersion("0.5.7", "minor"), "0.6.0");
    assert.equal(bumpVersion("0.5.7", "major"), "1.0.0");
  });

  it("rejects ambiguous, invalid, and non-strict inputs", () => {
    assert.throws(
      () => releaseBumpFromMessage("Release-Bump: minor\nRelease-Bump: patch"),
      /more than one/,
    );
    assert.throws(() => releaseBumpFromMessage("Release-Bump: feature"), /major, minor, or patch/);
    assert.throws(() => bumpVersion("0.6.0-beta.1", "patch"), /strict SemVer/);
  });
});
