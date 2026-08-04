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

execFileSync(process.execPath, [`${root}/scripts/localwp-site-checkout-acceptance.mjs`], {
  encoding: "utf8",
  env: { ...process.env, ZEROY_LOCALWP_PORT: port },
  stdio: "inherit",
});
const preparedOutput = wp(
  "eval",
  `global $wpdb;
$releaseId = $wpdb->get_var("SELECT release_id FROM " . zeroy_runtime_table('site_releases') . " WHERE state = 'awaiting-browser' ORDER BY created_at DESC LIMIT 1");
$prepared = is_string($releaseId) ? zeroy_runtime_site_release_receipt($releaseId) : null;
$push = null;
foreach ($wpdb->get_results("SELECT * FROM " . zeroy_runtime_table('push_receipts') . " ORDER BY created_at DESC", ARRAY_A) as $row) {
    $result = zeroy_runtime_decode_json((string) $row['result_json']);
    if (is_array($result) && ($result['candidate']['releaseId'] ?? null) === $releaseId) {
        $push = ['commandId' => $row['command_id'], 'requestHash' => $row['request_hash']];
        break;
    }
}
echo wp_json_encode(['ok' => is_array($prepared) && is_array($push), 'prepared' => $prepared, 'push' => $push]);`,
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
const response = await fetch(`http://localhost:${port}/wp-json/zeroy/v1/site-push/finalize`, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    "x-zeroy-key": key,
  },
  body: JSON.stringify({
    commandId: preparation.push.commandId,
    requestHash: preparation.push.requestHash,
    releaseId: preparation.prepared.releaseId,
    browserEvidence: evidence,
  }),
});
const receipt = await response.json();
assert.equal(response.status, 200, JSON.stringify(receipt));
assert.equal(receipt.release?.state, "activated");
assert.equal(receipt.release?.releaseId, preparation.prepared.releaseId);

const proofResponse = await fetch(
  `http://localhost:${port}/wp-json/zeroy/v1/site-release-proofs/${receipt.proof.proofId}`,
  { headers: { "x-zeroy-key": key } },
);
const proofEnvelope = await proofResponse.json();
assert.equal(proofResponse.status, 200, JSON.stringify(proofEnvelope));
assert.equal(proofEnvelope.contract, "zeroy/site-release-proof-summary@1");
assert.equal(proofEnvelope.state, "verified");
assert.equal(proofEnvelope.failureCount, 0);
assert.equal(
  evidence.results.length,
  preparation.prepared.browserVerification.scenarios.length *
    preparation.prepared.browserVerification.viewports.length,
);

const home = await fetch(`http://localhost:${port}/`);
assert.equal(home.status, 200);
assert.equal(
  home.headers.get("x-zeroy-stylesheet-identity"),
  preparation.prepared.zcss.stylesheetSetHash,
);
process.stdout.write(
  `${JSON.stringify({ ok: true, releaseId: receipt.release.releaseId, browserResults: evidence.results.length })}\n`,
);
