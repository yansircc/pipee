import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { externalCheckFailures } from "./headless-acceptance/external-check.mjs";
import { withLoopbackNoProxy } from "./headless-acceptance/no-proxy.mjs";
import { runHeadlessPi, safeToolLedgerSummary } from "./headless-acceptance/pi-runner.mjs";

const port = process.env.ZEROY_ZCSS_AGENT_LOCALWP_PORT;
const model = process.env.ZEROY_ACCEPTANCE_MODEL;
assert(
  port && /^\d+$/u.test(port),
  "ZEROY_ZCSS_AGENT_LOCALWP_PORT must identify a disposable LocalWP site.",
);
assert(model, "ZEROY_ACCEPTANCE_MODEL is required for real-Agent ZCSS acceptance.");

const root = resolve(import.meta.dirname, "..");
const wordpress = `/Users/yansir/.locwp/sites/${port}/wordpress`;
const pluginRoot = `${wordpress}/wp-content/plugins`;
const connector = `${pluginRoot}/zeroy-runtime-connector`;
const acf = `${pluginRoot}/advanced-custom-fields-pro`;
const acfSource =
  "/Users/yansir/.locwp/sites/10008/wordpress/wp-content/plugins/advanced-custom-fields-pro";
const mustUsePlugins = `${wordpress}/wp-content/mu-plugins`;
assert(existsSync(pluginRoot), `LocalWP plugins directory does not exist: ${pluginRoot}`);
assert(existsSync(acfSource), `ACF acceptance source does not exist: ${acfSource}`);
const shell = (args) =>
  execFileSync("locwp", ["wp", port, "--", ...args], { encoding: "utf8" }).trim();

try {
  shell(["plugin", "deactivate", "zeroy-runtime-connector"]);
} catch {
  // A clean disposable site may not have the plugin active yet.
}
shell([
  "eval",
  `global $wpdb;
foreach ($wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}zeroy_%'") as $table) { $wpdb->query("DROP TABLE IF EXISTS \`" . esc_sql($table) . "\`"); }
$wpdb->query("DELETE FROM {$wpdb->postmeta} WHERE meta_key LIKE '_zeroy_%'");
$wpdb->query("DELETE FROM {$wpdb->termmeta} WHERE meta_key LIKE '_zeroy_%'");
foreach (array_keys(wp_load_alloptions()) as $name) { if (str_starts_with($name, 'zeroy_runtime_')) delete_option($name); }`,
]);
await rm(connector, { recursive: true, force: true });
await mkdir(connector, { recursive: true });
execFileSync("rsync", ["-a", "--delete", `${root}/wordpress-plugin/`, `${connector}/`], {
  stdio: "inherit",
});
await rm(acf, { recursive: true, force: true });
await mkdir(acf, { recursive: true });
execFileSync("rsync", ["-a", "--delete", `${acfSource}/`, `${acf}/`], { stdio: "inherit" });
await mkdir(mustUsePlugins, { recursive: true });
execFileSync(
  "rsync",
  [
    "-a",
    `${root}/test-suite/fixtures/zcss-agent-site.php`,
    `${mustUsePlugins}/zcss-agent-site.php`,
  ],
  { stdio: "inherit" },
);
shell(["plugin", "activate", "advanced-custom-fields-pro"]);
shell(["plugin", "activate", "zeroy-runtime-connector"]);
shell([
  "eval",
  `$existing = get_page_by_path('acceptance-machine', OBJECT, 'machine');
$post_id = $existing instanceof WP_Post ? $existing->ID : wp_insert_post([
  'post_type' => 'machine',
  'post_status' => 'publish',
  'post_title' => 'Acceptance Machine',
  'post_name' => 'acceptance-machine',
  'post_content' => 'A deterministic machine used by the zeroY Agent acceptance.',
  'post_excerpt' => 'Remote-only ACF-backed acceptance content.',
]);
if (is_wp_error($post_id)) { throw new RuntimeException($post_id->get_error_message()); }
$term = term_exists('Acceptance Family', 'machine_family');
if (!$term) $term = wp_insert_term('Acceptance Family', 'machine_family', ['slug' => 'acceptance-family']);
if (is_wp_error($term)) { throw new RuntimeException($term->get_error_message()); }
wp_set_object_terms($post_id, [(int) $term['term_id']], 'machine_family');
update_field('field_zeroy_machine_summary', 'A compact industrial machine for acceptance.', $post_id);
update_field('field_zeroy_machine_capacity', '12 t/h', $post_id);`,
]);

const siteId = shell(["option", "get", "zeroy_runtime_site_id"]);
const connectionKey = shell(["option", "get", "zeroy_runtime_connection_key"]);
const sites = [
  {
    siteId,
    label: "zeroY ZCSS Agent acceptance",
    endpoint: `http://localhost:${port}`,
    connectionKey,
  },
];
const temporary = await mkdtemp(resolve(tmpdir(), "zeroy-zcss-agent-"));
const sessions = resolve(temporary, "sessions");
const workspace = resolve(temporary, "empty-workspace");
await Promise.all([sessions, workspace].map((path) => mkdir(path)));
const allowedTools = new Set([
  "zeroy_inspect",
  "zeroy_theme_stage",
  "zeroy_content_stage",
  "zeroy_site_commit",
]);
const inspectResources = new Set([
  "sites",
  "site",
  "schema",
  "inventory",
  "acf",
  "zcssContract",
  "styleSurface",
  "release",
  "draft",
  "proof",
  "themeFiles",
  "content",
  "integrity",
  "externalCheck",
]);
const contentInspectionKinds = new Set([
  "canonical",
  "adoption-candidates",
  "existing-post",
  "translation",
]);
const contentOperationKinds = new Set([
  "replayDraft",
  "siteConfig",
  "createCanonical",
  "adoptCanonical",
  "retireCanonical",
  "assignSchema",
  "writeTemplateContent",
  "writeCanonicalContent",
  "writeTranslationDraft",
  "publishTranslation",
  "unpublishTranslation",
]);
let completed = false;

const connectorErrorCode = (entry) =>
  typeof entry?.result?.payload?.error?.code === "string" ? entry.result.payload.error.code : null;
const nested = (value, key) => {
  if (typeof value !== "object" || value === null) return null;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = nested(child, key);
    if (found !== null) return found;
  }
  return null;
};

try {
  const environment = withLoopbackNoProxy(
    { ...process.env, ZEROY_SITES: JSON.stringify(sites) },
    sites,
  );
  const run = await runHeadlessPi({
    pi: resolve(root, "node_modules/.bin/pi"),
    extension: resolve(root, "dist/pi/extension.js"),
    model,
    cwd: workspace,
    sessions,
    name: "zeroY ZCSS from-zero Agent dogfood",
    env: environment,
    timeoutMs: 1_800_000,
    prompt: `Build and activate a complete minimal bilingual zeroY WordPress site on ${siteId}, using only the four zeroY tools. Never use local files, shell, source code, database, SSH, WP-CLI, browser tools, or any other tool. The default language must be English and Chinese must be enabled.

Start from discovery: inspect sites, site, ACF, zcssContract, and the bootstrap theme authoring contract. Author one ThemeManifest v3 ThemeArtifact from scratch with a ZCSS DesignDocument, manifest-declared site CSS, header/footer, home, ordinary document, one available ACF-backed CPT singular, its archive, one taxonomy collection, search, and 404. Keep the visual result intentionally simple but real. Use public ZCSS primitives plus at least one --site-* token, one component-private custom property, one custom CSS grid, and one custom animation that respects reduced motion.

After the first complete valid theme stage has created a Draft, deliberately attempt one invalid update to zcss.design.json by using a scale ratio outside its declared contract. This attempt must be rejected by the ZCSS compiler. Read the structured diagnostic and repair the same Draft with a valid complete DesignDocument; do not discard or replace that Draft.

Create and publish enough default and Chinese content for the home, ordinary page, and the chosen ACF-backed CPT so CandidateProof includes real singular and collection routes. Inspect the Draft styleSurface before commit and reuse one existing component selector in a later CSS update. Commit the exact Draft with its exact base release. Then inspect the active release, complete proof, active styleSurface, and externalCheck. Finish only after browser proof and external checks are green. Do not claim that machine verification proves visual taste or business quality.`,
  });
  assert(run.entries.length > 0, "Real-Agent ZCSS acceptance recorded no tool calls.");
  for (const entry of run.entries) {
    assert(allowedTools.has(entry.name), `Unexpected tool ${entry.name}.`);
    assert(Object.keys(entry.input ?? {}).length > 0, `Empty input for ${entry.name}.`);
    assert(entry.result, `Missing result for ${entry.name}.`);
    if (entry.name === "zeroy_inspect") {
      assert(
        inspectResources.has(entry.input.resource),
        `Unknown inspect resource ${String(entry.input.resource)}.`,
      );
      if (entry.input.resource === "content") {
        assert(
          contentInspectionKinds.has(entry.input.content?.kind),
          `Unknown content inspection ${String(entry.input.content?.kind)}.`,
        );
      }
    }
    if (entry.name === "zeroy_content_stage") {
      assert(
        contentOperationKinds.has(entry.input.operation?.kind),
        `Unknown content operation ${String(entry.input.operation?.kind)}.`,
      );
    }
  }
  const inspections = run.entries.filter((entry) => entry.name === "zeroy_inspect");
  const resources = new Set(inspections.map((entry) => entry.input.resource));
  for (const resource of [
    "sites",
    "site",
    "acf",
    "zcssContract",
    "styleSurface",
    "proof",
    "externalCheck",
  ]) {
    assert(resources.has(resource), `Agent did not inspect ${resource}.`);
  }
  const themeStages = run.entries.filter((entry) => entry.name === "zeroy_theme_stage");
  const invalid = themeStages.find(
    (entry) => connectorErrorCode(entry) === "zeroy_zcss_compile_failed",
  );
  assert(
    invalid,
    `Agent did not exercise deterministic ZCSS failure: ${JSON.stringify(safeToolLedgerSummary(run.entries))}`,
  );
  assert(
    typeof invalid.input.draftId === "string",
    "Invalid ZCSS probe happened before a real Draft existed.",
  );
  const repaired = themeStages.find(
    (entry) =>
      entry.index > invalid.index &&
      entry.input.draftId === invalid.input.draftId &&
      entry.input.files?.some((file) => file?.path === "zcss.design.json") &&
      connectorErrorCode(entry) === null,
  );
  assert(repaired, "Agent did not repair the rejected ZCSS design in the same Draft.");
  const cssWrites = themeStages
    .flatMap((entry) => entry.input.files ?? [])
    .filter((file) => typeof file?.content === "string" && file.path.endsWith(".css"));
  const css = cssWrites.map((file) => file.content).join("\n");
  assert.match(css, /--site-[a-z0-9-]+\s*:/u, "Agent authored no site token.");
  assert.match(
    css,
    /--(?!z-|site-)[a-z0-9-]+\s*:/u,
    "Agent authored no component-private property.",
  );
  assert.match(css, /display\s*:\s*grid/u, "Agent authored no custom grid.");
  assert.match(css, /@keyframes\s+[a-z0-9_-]+/u, "Agent authored no custom animation.");
  const draftSurfaces = inspections.filter(
    (entry) => entry.input.resource === "styleSurface" && typeof entry.input.draftId === "string",
  );
  assert(draftSurfaces.length >= 1, "Agent never inspected its Draft StyleSurface.");
  assert(
    themeStages.some(
      (entry) =>
        entry.index > draftSurfaces[0].index &&
        entry.input.draftId === draftSurfaces[0].input.draftId,
    ),
    "Agent did not use StyleSurface before a later theme refinement.",
  );
  const activeCommits = run.entries.filter(
    (entry) => entry.name === "zeroy_site_commit" && entry.result?.payload?.state === "active",
  );
  const commit = activeCommits[0];
  const finalCommit = activeCommits.at(-1);
  assert(
    commit,
    `Agent did not activate a SiteRelease: ${JSON.stringify(safeToolLedgerSummary(run.entries))}`,
  );
  assert.equal(
    commit.input.draftId,
    invalid.input.draftId,
    "Agent abandoned the repaired Draft before activation.",
  );
  const proofId = nested(commit.result.payload, "proofId");
  const proof = inspections.find(
    (entry) => entry.input.resource === "proof" && entry.input.proofId === proofId,
  );
  assert(proof, "Agent did not inspect the active CandidateProof.");
  const proofDocument = proof.result.payload.proof;
  assert.equal(proofDocument?.themeProof?.browserChecks?.kind, "browser-executed");
  assert.deepEqual(proofDocument?.blockingFailures, []);
  const external = inspections.findLast((entry) => entry.input.resource === "externalCheck");
  const pages = external?.result?.payload?.externalCheck?.pages;
  assert(Array.isArray(pages), "externalCheck returned no page evidence.");
  assert.deepEqual(externalCheckFailures(pages), []);
  process.stdout.write(
    `${JSON.stringify({ ok: true, sessionFile: run.sessionFile, releaseId: finalCommit.result.payload.releaseId, toolCalls: run.entries.length })}\n`,
  );
  completed = true;
} finally {
  if (completed) await rm(temporary, { recursive: true, force: true });
  else process.stderr.write(`Preserved failed ZCSS Agent acceptance at ${temporary}\n`);
}
