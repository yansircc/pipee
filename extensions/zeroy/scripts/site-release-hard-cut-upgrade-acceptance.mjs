import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.ZEROY_UPGRADE_LOCALWP_PORT;
if (!port || !/^\d+$/.test(port)) {
  throw new Error("ZEROY_UPGRADE_LOCALWP_PORT must identify a fresh disposable LocalWP site.");
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
execFileSync("locwp", ["wp", port, "--", "plugin", "activate", "zeroy-runtime-connector"], {
  stdio: "inherit",
});
execFileSync(
  "locwp",
  ["wp", port, "--", "eval-file", `${root}/test-suite/bootstrap-site-release-acceptance.php`],
  { stdio: "inherit" },
);
execFileSync(
  "locwp",
  [
    "wp",
    port,
    "--",
    "eval-file",
    `${root}/test-suite/site-release-hard-cut-upgrade-acceptance.php`,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "locwp",
  ["wp", port, "--", "eval-file", `${root}/test-suite/site-release-hard-cut-upgrade-assert.php`],
  { stdio: "inherit" },
);
