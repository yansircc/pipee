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
const initialBrief = "Verify an exact private PreviewRelease before an administrator publishes it.";
const briefResult = JSON.parse(
  wp("eval", `echo wp_json_encode(zeroy_review_set_brief('${initialBrief}'));`),
);
assert.equal(briefResult.state, "present");
const preparedOutput = wp(
  "eval",
  `global $wpdb;
$releaseId = get_option('zeroy_zcss_browser_acceptance_preview_release', '');
$prepared = is_string($releaseId) ? zeroy_runtime_site_release_receipt($releaseId) : null;
$push = null;
foreach ($wpdb->get_results("SELECT * FROM " . zeroy_runtime_table('push_receipts') . " ORDER BY created_at DESC", ARRAY_A) as $row) {
    $result = zeroy_runtime_decode_json((string) $row['result_json']);
    if (is_array($result) && ($result['preview']['releaseId'] ?? null) === $releaseId) {
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
assert(
  preparedLine,
  `Browser acceptance did not return an awaiting PreviewRelease: ${preparedOutput}`,
);
const preparation = JSON.parse(preparedLine);
assert.equal(preparation.ok, true);
assert.equal(preparation.prepared.state, "preview-awaiting-browser");

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
assert.equal(receipt.preview?.state, "proof-ready");
assert.equal(receipt.preview?.releaseId, preparation.prepared.releaseId);
const previewUrl = receipt.preview?.url;
assert.equal(typeof previewUrl, "string", "Proof-ready PreviewRelease has no private URL.");
const anonymousPreview = await fetch(previewUrl, { redirect: "manual" });
assert.equal(anonymousPreview.status, 404, "Anonymous traffic read a private PreviewRelease.");
const previewUser = `zeroy-preview-${Date.now().toString(36)}`;
const previewPassword = "zeroY-preview-test-2026";
wp(
  "eval",
  `if (!username_exists('${previewUser}')) wp_create_user('${previewUser}', '${previewPassword}', '${previewUser}@example.test'); $user=get_user_by('login','${previewUser}'); $user->set_role('administrator');`,
);
const login = await fetch(`http://localhost:${port}/wp-login.php`, {
  method: "POST",
  redirect: "manual",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    cookie: "wordpress_test_cookie=WP%20Cookie%20check",
  },
  body: new URLSearchParams({
    log: previewUser,
    pwd: previewPassword,
    "wp-submit": "Log In",
    redirect_to: previewUrl,
    testcookie: "1",
  }),
});
assert.equal(login.status, 302, "Could not create an administrator preview session.");
const adminCookies = login.headers
  .getSetCookie()
  .map((cookie) => cookie.split(";", 1)[0])
  .join("; ");
assert.notEqual(adminCookies, "", "Administrator login did not issue a session cookie.");
const administratorPreview = await fetch(previewUrl, {
  headers: { cookie: `wordpress_test_cookie=WP%20Cookie%20check; ${adminCookies}` },
});
assert.equal(
  administratorPreview.status,
  200,
  "Administrator could not read private PreviewRelease.",
);
assert.match(administratorPreview.headers.get("cache-control") ?? "", /no-store/i);
assert.match(administratorPreview.headers.get("x-robots-tag") ?? "", /noindex/i);
const previewHtml = await administratorPreview.text();
const previewAsset = previewHtml.match(
  /https?:[^"']+\/__zeroy-preview\/[^/]+\/__assets\/[^"']+/,
)?.[0];
assert(
  previewAsset,
  "Administrator PreviewRelease did not resolve styles through its private asset boundary.",
);
const anonymousAsset = await fetch(previewAsset, { redirect: "manual" });
assert.equal(anonymousAsset.status, 404, "Anonymous traffic read a private PreviewRelease asset.");
const administratorAsset = await fetch(previewAsset, {
  headers: { cookie: `wordpress_test_cookie=WP%20Cookie%20check; ${adminCookies}` },
});
assert.equal(
  administratorAsset.status,
  200,
  "Administrator could not read a private PreviewRelease asset.",
);
assert.match(administratorAsset.headers.get("cache-control") ?? "", /no-store/i);
const legacyArtifactUrl = previewAsset.replace(
  /\/__zeroy-preview\/[^/]+\/__assets\//,
  `/wp-content/zeroy-runtime/artifacts/${preparation.prepared.themeArtifactId.replace(":", "-")}/`,
);
const legacyArtifact = await fetch(legacyArtifactUrl, { redirect: "manual" });
assert.notEqual(
  legacyArtifact.status,
  200,
  "ThemeArtifact bytes remain directly readable below wp-content.",
);

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

const active = wp("eval", "echo wp_json_encode(zeroy_runtime_active_site_release());").trim();
assert.equal(
  JSON.parse(active)?.active_release_id ?? null,
  null,
  "Browser verification must not publish PreviewRelease.",
);
const staleBrief = JSON.parse(
  wp(
    "eval",
    `zeroy_review_set_brief('A changed Brief must invalidate this exact proof.'); $activation=zeroy_runtime_activate_site_release('${preparation.prepared.releaseId}'); echo wp_json_encode(is_wp_error($activation) ? ['error'=>$activation->get_error_code()] : ['release'=>$activation]);`,
  ),
);
assert.equal(staleBrief.error, "zeroy_site_review_stale");
const published = JSON.parse(
  wp(
    "eval",
    `zeroy_review_set_brief('${initialBrief}'); $activation=zeroy_runtime_activate_site_release('${preparation.prepared.releaseId}'); echo wp_json_encode(is_wp_error($activation) ? ['error'=>$activation->get_error_code(), 'message'=>$activation->get_error_message()] : $activation);`,
  ),
);
assert.equal(published.state, "active", JSON.stringify(published));
assert.equal(published.releaseId, preparation.prepared.releaseId);
const home = await fetch(`http://localhost:${port}/`);
assert.equal(home.status, 200);
assert.equal(
  home.headers.get("x-zeroy-stylesheet-identity"),
  preparation.prepared.zcss.stylesheetSetHash,
);
process.stdout.write(
  `${JSON.stringify({ ok: true, releaseId: receipt.preview.releaseId, browserResults: evidence.results.length })}\n`,
);
