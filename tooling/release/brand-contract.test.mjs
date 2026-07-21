import assert from "node:assert/strict";
import { it } from "node:test";
import { assertPipeeBrand, legacyHostIdentifiers } from "./brand-contract.mjs";

it("rejects every retired Host identity without permitting aliases", () => {
  const retired = [
    ["pi", "Su", "ite"].join(""),
    ["pi", "suite"].join("-"),
    ["pi", "suite"].join("_"),
    ["Pi", "Su", "ite"].join("").replace("Pi", "Pi "),
    ["pi", "web"].join("-"),
    ["Pi", "Web"].join(" "),
    ["get", "Pi", "Su", "ite", "Capability"].join(""),
    ["Pi", "Web", "Api"].join(""),
    ["pi", "Web", "BaseUrl"].join(""),
    ["suite", "Config"].join(""),
  ];
  for (const identity of retired) {
    assert.notDeepEqual(legacyHostIdentifiers(identity), [], identity);
  }
});

it("accepts the Pipee namespace and generic test-suite terminology", () => {
  assert.doesNotThrow(() =>
    assertPipeeBrand("pipee getPipeeCapability pipee/web-surface@2 test-suite", "fixture"),
  );
});
