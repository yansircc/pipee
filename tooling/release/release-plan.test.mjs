import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { releasePlanFromDocuments } from "./release-plan.mjs";

const config = {
  packages: [
    { id: "web", name: "@fixture/web", path: "apps/web" },
    { id: "loop", name: "@fixture/loop", path: "extensions/loop" },
  ],
};
const document = (file, changes) => ({ file, value: { schemaVersion: 1, changes } });

describe("public package release set", () => {
  it("selects only declared packages and collapses repeated bumps upward", () => {
    const plan = releasePlanFromDocuments(config, [
      document("release/changes/a.json", [{ package: "@fixture/web", bump: "patch" }]),
      document("release/changes/b.json", [{ package: "@fixture/web", bump: "minor" }]),
    ]);
    assert.deepEqual(plan.files, ["release/changes/a.json", "release/changes/b.json"]);
    assert.deepEqual(plan.packages, [{ ...config.packages[0], bump: "minor" }]);
  });

  it("allows an empty release set and rejects unknown packages or bumps", () => {
    assert.deepEqual(releasePlanFromDocuments(config, []), { files: [], packages: [] });
    assert.throws(
      () =>
        releasePlanFromDocuments(config, [
          document("release/changes/x.json", [{ package: "@fixture/nope", bump: "patch" }]),
        ]),
      /unknown public package/,
    );
    assert.throws(
      () =>
        releasePlanFromDocuments(config, [
          document("release/changes/x.json", [{ package: "@fixture/web", bump: "feature" }]),
        ]),
      /invalid bump/,
    );
  });
});
