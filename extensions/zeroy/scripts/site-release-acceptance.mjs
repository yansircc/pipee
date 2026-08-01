import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.ZEROY_LOCALWP_PORT;
if (!port || !/^\d+$/.test(port)) {
  throw new Error("ZEROY_LOCALWP_PORT must identify a disposable LocalWP site.");
}
const destination = `/Users/yansir/.locwp/sites/${port}/wordpress/wp-content/plugins/zeroy-runtime-connector/`;
const pluginRoot = `/Users/yansir/.locwp/sites/${port}/wordpress/wp-content/plugins`;
if (!existsSync(pluginRoot)) {
  throw new Error(`LocalWP plugins directory does not exist: ${pluginRoot}`);
}
await mkdir(destination, { recursive: true });
execFileSync("rsync", ["-a", "--delete", `${root}/wordpress-plugin/`, destination], {
  stdio: "inherit",
});
// The Stable Shell is plugin-owned and is selected by the activation hook.
// A disposable acceptance site may have retained a previous hard-cut shell.
execFileSync("locwp", ["wp", port, "--", "plugin", "deactivate", "zeroy-runtime-connector"], {
  stdio: "inherit",
});
execFileSync("locwp", ["wp", port, "--", "plugin", "activate", "zeroy-runtime-connector"], {
  stdio: "inherit",
});
const state = JSON.parse(
  execFileSync(
    "locwp",
    [
      "wp",
      port,
      "--",
      "eval",
      "global $wpdb; echo wp_json_encode(['active' => zeroy_runtime_active_site_release() !== null, 'releases' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_releases')), 'proofs' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('verification_proofs')), 'drafts' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_drafts')), 'migrations' => (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('site_logic_migration_ledger'))]);",
    ],
    { encoding: "utf8" },
  ),
);
if (
  state.active ||
  state.releases !== 0 ||
  state.proofs !== 0 ||
  state.drafts !== 0 ||
  state.migrations !== 0
) {
  throw new Error(
    `ZEROY_LOCALWP_PORT=${port} must be a fresh zeroY acceptance site; found ${JSON.stringify(state)}.`,
  );
}
execFileSync(
  "locwp",
  ["wp", port, "--", "eval-file", `${root}/test-suite/site-release-acceptance.php`],
  {
    stdio: "inherit",
  },
);
