import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { externalCheckFailures } from "./headless-acceptance/external-check.mjs";
import { runHeadlessPi } from "./headless-acceptance/pi-runner.mjs";
import { withLoopbackNoProxy } from "./headless-acceptance/no-proxy.mjs";

for (const key of ["ZEROY_SITES", "ZEROY_ACCEPTANCE_SITE_ID", "ZEROY_ACCEPTANCE_MODEL"])
  assert(process.env[key], `${key} is required for headless acceptance.`);
const sites = JSON.parse(process.env.ZEROY_SITES);
const siteId = process.env.ZEROY_ACCEPTANCE_SITE_ID;
assert(
  Array.isArray(sites) && sites.some((site) => site?.siteId === siteId),
  "Selected zeroY site is not configured.",
);
const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-checkout-acceptance-"));
const run = Date.now().toString(36);

try {
  const execution = await runHeadlessPi({
    pi: resolve(root, "node_modules/.bin/pi"),
    extension: resolve(root, "dist/pi/extension.js"),
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: temporary,
    sessions: resolve(temporary, "sessions"),
    name: "zeroY SiteCheckout headless acceptance",
    env: withLoopbackNoProxy({ ...process.env, ZEROY_SITES: process.env.ZEROY_SITES }, sites),
    prompt: `Work on zeroY site ${siteId} through its current tools. Discover sites and refs, checkout the active release, and use ordinary local file tools only inside the returned checkout path. Make one harmless visible CSS change containing marker ${run}; do not read the extension or Connector source. Push the same checkout as a release, inspect its proof if blocked, repair only the checkout, and finish with integrity and externalCheck. Do not invent transport ids, revisions, hashes, or remote filesystem access.`,
  });
  const zeroY = execution.entries.filter((entry) => entry.name.startsWith("zeroy_"));
  assert(zeroY.length > 0, "No zeroY tool call was recorded.");
  for (const entry of zeroY) {
    assert(
      ["zeroy_inspect", "zeroy_checkout", "zeroy_push"].includes(entry.name),
      `Deleted zeroY tool survived: ${entry.name}.`,
    );
    assert(entry.input && Object.keys(entry.input).length > 0, `Empty input for ${entry.name}.`);
    assert(entry.result && !entry.result.isError, `${entry.name} failed.`);
    assert.doesNotMatch(
      entry.result.text,
      /operationSummaries|fileContent|bytesBase64/u,
      `${entry.name} leaked history or file bytes into the transcript.`,
    );
  }
  const checkout = zeroY.find((entry) => entry.name === "zeroy_checkout");
  assert(checkout, "SiteCheckout was not exercised.");
  const checkoutId = checkout.result?.payload?.checkoutId;
  assert(typeof checkoutId === "string", "Checkout result has no checkoutId.");
  const pushes = zeroY.filter((entry) => entry.name === "zeroy_push");
  assert(pushes.length >= 1, "No SiteCheckout push was exercised.");
  assert(
    pushes.every((entry) => entry.input.checkoutId === checkoutId),
    "Push escaped its checkout.",
  );
  const release = pushes.find((entry) => entry.input.mode === "release");
  assert(release, "No release push was exercised.");
  const changedPushes = pushes.filter(
    (entry) => Number(entry.result?.payload?.changeSummary?.changedPathCount ?? 0) > 0,
  );
  assert(changedPushes.length > 0, "No push contained the requested local change.");
  assert.equal(
    release.result?.payload?.commit,
    changedPushes.at(-1)?.result?.payload?.commit,
    "Release did not identify the changed checkpoint commit.",
  );
  const resources = new Set(
    zeroY.filter((entry) => entry.name === "zeroy_inspect").map((entry) => entry.input.resource),
  );
  for (const resource of ["sites", "refs", "integrity", "externalCheck"])
    assert(resources.has(resource), `Inspect ${resource} was not exercised.`);
  const external = [...zeroY]
    .reverse()
    .find((entry) => entry.name === "zeroy_inspect" && entry.input.resource === "externalCheck")
    ?.result?.payload?.externalCheck;
  assert(external && Array.isArray(external.pages), "External check returned no page evidence.");
  const transportFailures = externalCheckFailures(external.pages).filter(
    (failure) => failure.error !== null || failure.status !== failure.expectedStatus,
  );
  assert.deepEqual(transportFailures, []);
  process.stdout.write("zeroY SiteCheckout headless acceptance passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
