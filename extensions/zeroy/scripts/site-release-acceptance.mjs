import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.ZEROY_LOCALWP_PORT;
if (!port || !/^\d+$/.test(port)) {
  throw new Error("ZEROY_LOCALWP_PORT must identify a disposable LocalWP site.");
}
const destination = `/Users/yansir/.locwp/sites/${port}/wordpress/wp-content/plugins/zeroy-runtime-connector/`;
if (!existsSync(destination)) {
  throw new Error(`LocalWP plugin directory does not exist: ${destination}`);
}
execFileSync("rsync", ["-a", "--delete", `${root}/wordpress-plugin/`, destination], {
  stdio: "inherit",
});
execFileSync(
  "locwp",
  ["wp", port, "--", "eval-file", `${root}/test-suite/site-release-acceptance.php`],
  {
    stdio: "inherit",
  },
);
