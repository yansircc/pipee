import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.ZEROY_ZCSS_BROWSER_LOCALWP_PORT;
if (!port || !/^\d+$/.test(port)) {
  throw new Error("ZEROY_ZCSS_BROWSER_LOCALWP_PORT must identify a disposable LocalWP site.");
}
const wordpress = `/Users/yansir/.locwp/sites/${port}/wordpress`;
const pluginRoot = `${wordpress}/wp-content/plugins`;
const destination = `${pluginRoot}/zeroy-runtime-connector/`;
assert(existsSync(pluginRoot), `LocalWP plugins directory does not exist: ${pluginRoot}`);

const wp = (...args) =>
  execFileSync("locwp", ["wp", port, "--", ...args], {
    encoding: "utf8",
    env: process.env,
  });

try {
  wp("plugin", "deactivate", "zeroy-runtime-connector");
} catch {
  // A clean disposable site may not have the plugin active yet.
}
wp(
  "eval",
  `global $wpdb;
foreach ($wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}zeroy_%'") as $table) { $wpdb->query("DROP TABLE IF EXISTS \`" . esc_sql($table) . "\`"); }
$wpdb->query("DELETE FROM {$wpdb->postmeta} WHERE meta_key LIKE '_zeroy_%'");
$wpdb->query("DELETE FROM {$wpdb->termmeta} WHERE meta_key LIKE '_zeroy_%'");
foreach (array_keys(wp_load_alloptions()) as $name) { if (str_starts_with($name, 'zeroy_runtime_')) delete_option($name); }`,
);
await mkdir(destination, { recursive: true });
execFileSync("rsync", ["-a", "--delete", `${root}/wordpress-plugin/`, destination], {
  stdio: "inherit",
});
wp("plugin", "activate", "zeroy-runtime-connector");

const preparedOutput = execFileSync(
  "locwp",
  ["wp", port, "--", "eval-file", `${root}/test-suite/bootstrap-site-release-acceptance.php`],
  {
    encoding: "utf8",
    env: { ...process.env, ZEROY_BROWSER_ACCEPTANCE_PREPARE: "1" },
  },
);
const preparedLine = preparedOutput
  .trim()
  .split("\n")
  .reverse()
  .find((line) => line.trim().startsWith("{"));
assert(preparedLine, `Browser acceptance did not return a prepared candidate: ${preparedOutput}`);
const preparation = JSON.parse(preparedLine);
assert.equal(preparation.ok, true);
assert.equal(preparation.prepared.state, "awaiting-browser");

const built = await import(pathToFileURL(resolve(root, "dist/pi/extension.js")).href);
assert.equal(
  typeof built.verifyBrowserChallengeWithLocalBrowser,
  "function",
  "Pi bundle does not export its browser verifier for deterministic acceptance.",
);
const evidence = await Effect.runPromise(
  built
    .verifyBrowserChallengeWithLocalBrowser(preparation.prepared.browserVerification)
    .pipe(Effect.provide(nodeServicesLayer)),
);
const key = wp("option", "get", "zeroy_runtime_connection_key").trim();
const response = await fetch(
  `http://localhost:${port}/wp-json/zeroy/v1/site-releases/${preparation.prepared.releaseId}/browser-evidence`,
  {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-zeroy-key": key,
      "x-zeroy-draft-owner": preparation.ownerId,
    },
    body: JSON.stringify({ browserEvidence: evidence }),
  },
);
const receipt = await response.json();
assert.equal(response.status, 200, JSON.stringify(receipt));
assert.equal(receipt.state, "active");
assert.equal(receipt.browserVerification, null);

const proofResponse = await fetch(
  `http://localhost:${port}/wp-json/zeroy/v1/site-release-proofs/${receipt.proofId}`,
  { headers: { "x-zeroy-key": key } },
);
const proofEnvelope = await proofResponse.json();
assert.equal(proofResponse.status, 200, JSON.stringify(proofEnvelope));
const proof = proofEnvelope.proof;
assert.equal(proof.themeProof.browserChecks.kind, "browser-executed");
assert.deepEqual(proof.themeProof.browserChecks.failures, []);
assert.equal(
  proof.themeProof.browserChecks.executed.length,
  preparation.prepared.browserVerification.scenarios.length *
    preparation.prepared.browserVerification.viewports.length,
);
assert.deepEqual(proof.blockingFailures, []);

const home = await fetch(`http://localhost:${port}/`);
assert.equal(home.status, 200);
assert.equal(home.headers.get("x-zeroy-stylesheet-identity"), receipt.zcss.stylesheetSetHash);
process.stdout.write(
  `${JSON.stringify({ ok: true, releaseId: receipt.releaseId, browserResults: proof.themeProof.browserChecks.executed.length })}\n`,
);
