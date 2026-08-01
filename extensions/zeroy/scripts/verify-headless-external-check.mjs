import assert from "node:assert/strict";
import { externalCheckFailures } from "./headless-acceptance/external-check.mjs";

const page = (overrides = {}) => ({
  scenarioId: "page",
  expectedStatus: 200,
  status: 200,
  error: null,
  brokenLinks: [],
  ...overrides,
});

assert.deepEqual(
  externalCheckFailures([
    page(),
    page({ scenarioId: "not-found", expectedStatus: 404, status: 404 }),
  ]),
  [],
);
assert.deepEqual(
  externalCheckFailures([page({ scenarioId: "not-found", expectedStatus: 404, status: 200 })]),
  [{ scenarioId: "not-found", expectedStatus: 404, status: 200, error: null, brokenLinks: 0 }],
);
assert.deepEqual(
  externalCheckFailures([
    page({ scenarioId: "broken", brokenLinks: ["http://site.test/missing"] }),
  ]),
  [{ scenarioId: "broken", expectedStatus: 200, status: 200, error: null, brokenLinks: 1 }],
);

process.stdout.write("zeroY headless external-check policy passed.\n");
