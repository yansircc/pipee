import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { remoteOnlyAccessViolations } from "./headless-acceptance/access-policy.mjs";
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
  const bootstrap = await runHeadlessPi({
    pi: resolve(root, "node_modules/.bin/pi"),
    extension: resolve(root, "dist/pi/extension.js"),
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: temporary,
    sessions: resolve(temporary, "bootstrap-sessions"),
    name: "zeroY SiteCheckout recovery checkpoint",
    env: withLoopbackNoProxy({ ...process.env, ZEROY_SITES: process.env.ZEROY_SITES }, sites),
    timeoutMs: 600_000,
    prompt: `Create the remote recovery point for zeroY site ${siteId}. Use only the three zeroY tools and ordinary local file tools inside the path returned by zeroy_checkout. Do not call read, write, edit, or bash before zeroy_checkout returns a path. After checkout, every read/write/edit path must be inside that checkout and every bash command, including pwd or status checks, must literally contain and cd to the absolute checkout path returned by zeroy_checkout. Inspect sites, checkout the bootstrap active release, read .zeroy/README.md, preserve every Connector-staged English WordPress/ACF seed, ensure site.json uses English as default plus Japanese and Italian, and push one checkpoint even if the BuildResult is invalid. Do not inspect this repository, LocalWP, processes, environment variables, localhost REST, or any checkout sibling. Do not build the theme or release yet. Report the DraftRef and stop.`,
  });
  const execution = await runHeadlessPi({
    pi: resolve(root, "node_modules/.bin/pi"),
    extension: resolve(root, "dist/pi/extension.js"),
    model: process.env.ZEROY_ACCEPTANCE_MODEL,
    cwd: temporary,
    sessions: resolve(temporary, "delivery-sessions"),
    name: "zeroY SiteCheckout recovered delivery",
    env: withLoopbackNoProxy({ ...process.env, ZEROY_SITES: process.env.ZEROY_SITES }, sites),
    timeoutMs: 3_600_000,
    prompt: `This is a completely new session. Recover zeroY site ${siteId} only from the Connector DraftRef and its checkout projection: inspect refs, checkout the sole latest draft, then start from .zeroy/README.md and repair-frontier.json. Do not call read, write, edit, or bash before zeroy_checkout returns a path. After checkout, every read/write/edit path must be inside that checkout and every bash command, including pwd or status checks, must literally contain and cd to the absolute checkout path returned by zeroy_checkout. Do not inspect this repository, extension source, LocalWP, processes, environment variables, localhost REST, or any checkout sibling. Preserve the staged English WordPress and ACF business facts. Deliver a complete industrial website with English as default plus Japanese and Italian: header, footer, homepage, every mapped CPT singular and archive, every applicable taxonomy collection, contact page, search, and 404. Exercise the staged ACF repeater, relationship, taxonomy, and media data. Use checkpoints as needed, read exact linked contracts/templates/diagnostics, and do not guess field ids, revisions, hashes, transport ids, or WordPress ids. The final theme must include harmless marker ${run}. Push this same recovered checkout as a release; when proof is blocked, inspect proof repairGroups and repair only authored checkout files. Use failureInstances only when one repair group's bounded examples are insufficient to diagnose verifier execution. Finish by running integrity and externalCheck and report only after all scenarios pass.`,
  });
  for (const runResult of [bootstrap, execution]) {
    const checkoutPaths = runResult.entries
      .filter((entry) => entry.name === "zeroy_checkout")
      .map((entry) => entry.result?.payload?.path)
      .filter((path) => typeof path === "string");
    assert.deepEqual(
      remoteOnlyAccessViolations({
        entries: runResult.entries,
        cwd: temporary,
        checkoutPaths,
        forbiddenRoots: [root],
      }),
      [],
      "Agent escaped the Connector checkout or used a local side channel.",
    );
  }
  const zeroY = [...bootstrap.entries, ...execution.entries].filter((entry) =>
    entry.name.startsWith("zeroy_"),
  );
  assert(zeroY.length > 0, "No zeroY tool call was recorded.");
  for (const entry of zeroY) {
    assert(
      ["zeroy_inspect", "zeroy_checkout", "zeroy_push"].includes(entry.name),
      `Deleted zeroY tool survived: ${entry.name}.`,
    );
    assert(entry.input && Object.keys(entry.input).length > 0, `Empty input for ${entry.name}.`);
    assert(entry.result, `${entry.name} did not return a result.`);
    assert.doesNotMatch(
      entry.result.text,
      /Validation failed/u,
      `${entry.name} used a validation probe.`,
    );
    assert.doesNotMatch(
      entry.result.text,
      /operationSummaries|fileContent|bytesBase64/u,
      `${entry.name} leaked history or file bytes into the transcript.`,
    );
  }
  const checkouts = zeroY.filter((entry) => entry.name === "zeroy_checkout");
  assert(checkouts.length >= 2, "A new session did not recover through a fresh SiteCheckout.");
  const checkoutIds = new Set(checkouts.map((entry) => entry.result?.payload?.checkoutId));
  assert([...checkoutIds].every((value) => typeof value === "string"));
  const pushes = zeroY.filter((entry) => entry.name === "zeroy_push");
  assert(pushes.length >= 1, "No SiteCheckout push was exercised.");
  assert(
    pushes.every((entry) => checkoutIds.has(entry.input.checkoutId)),
    "Push escaped all materialized checkouts.",
  );
  const release = pushes.find((entry) => entry.input.mode === "release");
  assert(release, "No release push was exercised.");
  assert.equal(release.result?.payload?.proof?.state, "verified", "Release proof is not verified.");
  const changedPushes = pushes.filter((entry) => typeof entry.result?.payload?.commit === "string");
  assert(changedPushes.length > 0, "No push produced a new SiteCommit for the local change.");
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
  const integrity = [...zeroY]
    .reverse()
    .find((entry) => entry.name === "zeroy_inspect" && entry.input.resource === "integrity")
    ?.result?.payload;
  assert.equal(integrity?.ok, true, "Final Connector integrity is not green.");
  const external = [...zeroY]
    .reverse()
    .find(
      (entry) =>
        entry.name === "zeroy_inspect" &&
        entry.input.resource === "externalCheck" &&
        entry.result?.payload?.contract === "zeroy/external-check-summary@1",
    )?.result?.payload;
  assert.equal(external?.contract, "zeroy/external-check-summary@1");
  assert.equal(external?.failureCount, 0, "External check reported failed pages.");
  assert.equal(external?.brokenLinkCount, 0, "External check reported broken links.");
  assert(typeof external?.pageCount === "number" && external.pageCount > 0);
  const releaseCheckout = checkouts.find(
    (entry) => entry.result?.payload?.checkoutId === release.input.checkoutId,
  );
  assert(releaseCheckout, "Release checkout path is not recoverable from the tool ledger.");
  const site = JSON.parse(
    await readFile(resolve(releaseCheckout.result.payload.path, "site.json"), "utf8"),
  );
  assert.equal(site.defaultLocale, "en");
  assert.deepEqual(new Set(site.locales), new Set(["en", "ja", "it"]));
  const routeKinds = new Set(Array.isArray(external.routeKinds) ? external.routeKinds : []);
  for (const kind of ["front-page", "singular", "archive", "taxonomy", "search", "not-found"])
    assert(routeKinds.has(kind), `External check did not cover ${kind}.`);
  process.stdout.write("zeroY SiteCheckout headless acceptance passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
