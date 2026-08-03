import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const port = process.env.ZEROY_LOCALWP_PORT ?? "10014";
const endpoint = `http://localhost:${port}/wp-json/zeroy/v1`;
const wp = (...args) =>
  execFileSync("locwp", ["wp", port, "--", ...args], { encoding: "utf8" }).trim();
const key = wp("option", "get", "zeroy_runtime_connection_key");
const fail = (message, evidence) => {
  throw new Error(
    `${message}${evidence === undefined ? "" : `\n${JSON.stringify(evidence, null, 2)}`}`,
  );
};
const canonicalValue = (value) =>
  Array.isArray(value)
    ? value.map(canonicalValue)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
            .map(([name, entry]) => [name, canonicalValue(entry)]),
        )
      : value;
const requestHash = (value) => {
  const bytes = JSON.stringify(canonicalValue(value));
  return createHash("sha256")
    .update(`push-request\0${Buffer.byteLength(bytes)}\0`)
    .update(bytes)
    .digest("hex");
};
const post = async (path, body) => {
  const response = await fetch(`${endpoint}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-zeroy-key": key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const get = async (path) => {
  const response = await fetch(`${endpoint}/${path}`, { headers: { "x-zeroy-key": key } });
  return { status: response.status, body: await response.json() };
};
const makeRequest = (refName, commitHash, mode, label) => {
  const request = {
    checkoutId: label,
    refName,
    expectedCommit: null,
    commitHash,
    mode,
    message: label,
    changeSummary: {
      changedPathCount: 0,
      changedSubjectCount: 0,
      uploadedObjectCount: 0,
      uploadedBytes: 0,
    },
  };
  return { commandId: randomUUID(), requestHash: requestHash(request), ...request };
};
const fixture = JSON.parse(
  wp(
    "eval",
    String.raw`
$release = zeroy_runtime_active_site_release();
$parent = (string) $release['commit_hash'];
$row = zeroy_checkout_commit_row($parent);
$commits = [];
foreach (['left', 'right', 'shared-release'] as $index => $label) {
    $commit = [
        'contract' => 'zeroy/site-commit@1',
        'tree' => (string) $row['tree_hash'],
        'parents' => [$parent],
        'baseReleaseId' => (string) $release['active_release_id'],
        'author' => ['principal' => zeroy_checkout_owner_principal(), 'actorSessionId' => 'localwp-acceptance'],
        'message' => 'LocalWP acceptance ' . $label . ' ' . wp_generate_uuid4(),
        'createdAt' => gmdate('c', 1785733200 + $index),
    ];
    $hash = zeroy_checkout_commit_hash($commit);
    $stored = zeroy_checkout_store_commit($commit, $hash);
    if (is_wp_error($stored)) {
        echo wp_json_encode(['error' => $stored->get_error_code()]);
        return;
    }
    $commits[] = $hash;
}
$empty_tree = zeroy_checkout_store_file_tree([]);
$blocked = [
    'contract' => 'zeroy/site-commit@1',
    'tree' => $empty_tree,
    'parents' => [$parent],
    'baseReleaseId' => (string) $release['active_release_id'],
    'author' => ['principal' => zeroy_checkout_owner_principal(), 'actorSessionId' => 'localwp-acceptance'],
    'message' => 'LocalWP blocked preflight ' . wp_generate_uuid4(),
    'createdAt' => gmdate('c', 1785733203),
];
$blocked_hash = zeroy_checkout_commit_hash($blocked);
$blocked_stored = zeroy_checkout_store_commit($blocked, $blocked_hash);
if (is_wp_error($blocked_stored)) {
    echo wp_json_encode(['error' => $blocked_stored->get_error_code()]);
    return;
}
$commits[] = $blocked_hash;
echo wp_json_encode([
    'activeCommit' => $parent,
    'commits' => $commits,
    'casRef' => 'refs/drafts/acceptance/' . wp_generate_uuid4(),
    'releaseRefs' => [
        'refs/drafts/acceptance/' . wp_generate_uuid4(),
        'refs/drafts/acceptance/' . wp_generate_uuid4(),
    ],
    'blockedRef' => 'refs/drafts/acceptance/' . wp_generate_uuid4(),
]);`,
  ),
);
if (fixture.error) fail("Could not prepare LocalWP checkout fixture.", fixture);

const left = makeRequest(fixture.casRef, fixture.commits[0], "checkpoint", "cas-left");
const right = makeRequest(fixture.casRef, fixture.commits[1], "checkpoint", "cas-right");
const cas = await Promise.all([post("site-push", left), post("site-push", right)]);
const success = cas.find((result) => result.status === 201);
const conflict = cas.find((result) => result.status === 409);
if (!success || conflict?.body?.error?.code !== "zeroy_remote_ref_changed")
  fail("Concurrent pushes did not produce exactly one CAS winner.", cas);

const winner = success.body.commit === left.commitHash ? left : right;
const replay = await post("site-push", winner);
if (replay.status !== 200 || !isDeepStrictEqual(replay.body, success.body))
  fail("A response-loss retry did not return the exact stored PushReceipt.", { success, replay });
const reused = await post("site-push", { ...winner, requestHash: "f".repeat(64) });
if (reused.status !== 409 || reused.body?.error?.code !== "zeroy_push_command_reused")
  fail("commandId reuse with a different request was not rejected.", reused);
const forged = await post("site-push", { ...winner, message: "changed but hash retained" });
if (forged.status !== 409 || forged.body?.error?.code !== "zeroy_push_command_reused")
  fail("A changed request could reuse a previously accepted requestHash.", forged);

const exact = await get(
  `site-checkout?source=commit&commit=${encodeURIComponent(winner.commitHash)}`,
);
if (exact.status !== 200 || exact.body?.commit !== winner.commitHash)
  fail("Exact-commit checkout projection is not addressable.", exact);
const files = Array.isArray(exact.body?.files) ? exact.body.files.map((item) => item.path) : [];
const siteFile = exact.body?.files?.find((item) => item.path === "site.json");
const siteObject = siteFile ? await get(`site-objects/${siteFile.hash}`) : null;
if (siteObject?.status !== 200 || typeof siteObject.body?.bytesBase64 !== "string")
  fail("SiteCheckout object projection is not readable.", { siteFile, siteObject });
const site = siteObject
  ? JSON.parse(Buffer.from(siteObject.body.bytesBase64, "base64").toString("utf8"))
  : null;
const defaultLocale = site?.config?.defaultLocale;
if (!defaultLocale || files.some((path) => path.startsWith(`translations/${defaultLocale}/`)))
  fail("The default locale leaked into translation projection.", { defaultLocale, files });
if (!files.includes("content/site-copy.json") || site?.config?.siteCopy !== undefined)
  fail("SiteCopy has more than one checkout owner.", { site, files });

const shared = fixture.commits[2];
const releaseRequests = fixture.releaseRefs.map((ref, index) =>
  makeRequest(ref, shared, "release", `same-commit-release-${index}`),
);
const releases = await Promise.all(releaseRequests.map((request) => post("site-push", request)));
if (releases.some((result) => result.status !== 201))
  fail("Concurrent same-commit release preparation failed.", releases);
const releaseIds = releases.map(
  (result) => result.body?.candidate?.releaseId ?? result.body?.release?.releaseId,
);
if (!releaseIds[0] || releaseIds[0] !== releaseIds[1])
  fail("Concurrent same-commit pushes created more than one SiteRelease.", releases);

const blocked = makeRequest(fixture.blockedRef, fixture.commits[3], "release", "blocked-preflight");
const blockedResult = await post("site-push", blocked);
if (blockedResult.status !== 201 || blockedResult.body?.preflight?.state !== "blocked")
  fail("A blocked release did not preserve an actionable preflight receipt.", blockedResult);
const blockedState = JSON.parse(
  wp(
    "eval",
    `$ref=zeroy_checkout_ref_row('${fixture.blockedRef}'); $receipt=zeroy_checkout_push_receipt('${blocked.commandId}'); echo wp_json_encode(['ref'=>$ref,'receipt'=>$receipt]);`,
  ),
);
if (
  blockedState.ref?.commit_hash !== fixture.commits[3] ||
  blockedState.receipt?.result?.preflight?.state !== "blocked"
)
  fail("Blocked preflight lost its DraftRef or PushReceipt recovery facts.", blockedState);

const garbageBytes = `unreachable-${randomUUID()}`;
const garbage = JSON.parse(
  wp(
    "eval",
    `$bytes='${garbageBytes}'; $hash=zeroy_checkout_blob_hash($bytes); $stored=zeroy_checkout_store_object('blob',$hash,$bytes); global $wpdb; $wpdb->update(zeroy_runtime_table('site_objects'), ['created_at'=>gmdate('Y-m-d H:i:s', time()-3*DAY_IN_SECONDS)], ['object_hash'=>$hash]); $gc=zeroy_checkout_gc(DAY_IN_SECONDS); echo wp_json_encode(['hash'=>$hash,'stored'=>$stored,'gc'=>$gc,'remaining'=>zeroy_checkout_object_row($hash)]);`,
  ),
);
if (garbage.remaining !== null || garbage.gc?.deletedObjects < 1)
  fail("Reachability GC did not collect an expired unreachable object.", garbage);

const reachability = JSON.parse(wp("eval", "echo wp_json_encode(zeroy_checkout_reachability());"));
if (!Array.isArray(reachability.issues) || reachability.issues.length !== 0)
  fail("Reachability integrity is not green after checkout acceptance.", reachability);

console.log("zeroY LocalWP SiteCheckout concurrency and recovery acceptance passed.");
