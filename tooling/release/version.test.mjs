import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpVersion } from "./version.mjs";

describe("independent package version algebra", () => {
  it("increments one package without projecting a Pipee version", () => {
    assert.equal(bumpVersion("0.1.8", "patch"), "0.1.9");
    assert.equal(bumpVersion("0.1.8", "minor"), "0.2.0");
    assert.equal(bumpVersion("0.1.8", "major"), "1.0.0");
  });

  it("rejects invalid bump and non-strict SemVer", () => {
    assert.throws(() => bumpVersion("0.6.0-beta.1", "patch"), /strict SemVer/);
    assert.throws(() => bumpVersion("0.6.0", "feature"), /unknown release bump/);
  });
});
