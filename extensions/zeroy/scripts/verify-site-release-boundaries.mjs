import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rawPackageRoot = process.argv.slice(2).find((argument) => argument !== "--");
const root = resolve(
  rawPackageRoot ?? dirname(fileURLToPath(import.meta.url)),
  rawPackageRoot ? "." : "..",
);
const pluginArchiveAllowlist = (path) =>
  path === "wordpress-plugin/zeroy-runtime-connector.php" ||
  path === "wordpress-plugin/default-site-logic/bootstrap.php" ||
  path === "wordpress-plugin/default-site-logic/sitelogic.json" ||
  path === "wordpress-plugin/stable-shell/functions.php" ||
  path === "wordpress-plugin/stable-shell/index.php" ||
  path === "wordpress-plugin/stable-shell/style.css" ||
  (/^wordpress-plugin\/includes\/.+\.php$/u.test(path) && !path.includes("//"));
const archiveAllowlist = (path) =>
  path === "package.json" ||
  path === "README.md" ||
  path === "LICENSE" ||
  path.startsWith("dist/pi/") ||
  path.startsWith("dist/web/") ||
  pluginArchiveAllowlist(path);

const list = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? list(path) : entry.isFile() ? [path] : [];
      }),
    )
  ).flat();
};

const archivePaths = rawPackageRoot
  ? (await list(root)).map((path) => relative(root, path))
  : JSON.parse(
      execFileSync("npm", ["pack", "--json", "--dry-run"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )[0]?.files?.map((entry) => entry?.path);

assert(Array.isArray(archivePaths), "npm pack did not return a production archive manifest.");
for (const path of archivePaths) {
  assert(
    typeof path === "string" && archiveAllowlist(path),
    `Production archive contains a non-connector path: ${String(path)}.`,
  );
  assert(
    !/(^|\/)(?:mvp-theme|test-suite|fixtures)(?:\/|$)/.test(path),
    `Production archive contains a site fixture: ${path}.`,
  );
  assert(
    !/(?:acf(?:-|_)?export|localwp|zeroy\.schema\.json)$/i.test(path),
    `Production archive contains site data: ${path}.`,
  );
}
const pluginFiles = await list(join(root, "wordpress-plugin"));
const source = await Promise.all(
  pluginFiles
    .filter((path) => path.endsWith(".php"))
    .map(async (path) => [relative(root, path), await readFile(path, "utf8")]),
);
for (const [path, text] of source) {
  assert.doesNotMatch(
    text,
    /(?:localhost:\d+|LocalWP|MVP Showcase|Industrial Home|zeroy_mvp_theme_assets)/,
    `${path} leaks fixture-only site data into the production Connector.`,
  );
  assert.doesNotMatch(
    text,
    /(?:mvp-theme|test-suite\/fixtures)/,
    `${path} reaches across the production/fixture boundary.`,
  );
}
const releaseBundle = await readFile(join(root, "dist/pi/extension.js"), "utf8");
assert.doesNotMatch(
  releaseBundle,
  /(?:localhost:\d+|LocalWP|MVP Showcase|Industrial Home|zeroy_mvp_theme_assets|mvp-theme|test-suite\/fixtures)/,
  "Production Pi bundle leaks fixture-only site data or a local-site identity.",
);
const theme = source.filter(([path]) => path.includes("/stable-shell/"));
const connector = source.filter(([path]) => path.startsWith("wordpress-plugin/includes/"));
const siteLogic = source.filter(([path]) => path.includes("/site-logic/"));
for (const [path, text] of theme) {
  assert.doesNotMatch(
    text,
    /\b(?:update_option|add_option|delete_option|wp_insert_post|wp_update_post|wp_delete_post|update_post_meta|add_post_meta|delete_post_meta|update_field|add_row|update_row|delete_row|dbDelta|wp_schedule_event|wp_schedule_single_event|register_rest_route|file_put_contents|get_permalink|the_permalink|post_type_link)\s*\(/i,
    `${path} crosses the read-only Theme boundary.`,
  );
}
for (const [path, text] of siteLogic) {
  assert.doesNotMatch(
    text,
    /\b(?:get_header|get_footer|get_sidebar|wp_head|wp_footer|locate_template|load_template|the_content)\s*\(/i,
    `${path} crosses the SiteLogic rendering boundary.`,
  );
}
for (const [path, text] of connector) {
  assert.doesNotMatch(
    text,
    /\b(?:rfq|crmSync|productSelection)\b/i,
    `${path} leaks a site-specific business identity into Connector.`,
  );
}
assert.equal(
  source.some(([path]) => path.endsWith("includes/theme/activation.php")),
  false,
  "ThemeDeployment activation must not survive the SiteRelease hard cut.",
);
assert.equal(
  source.some(([path]) => path.endsWith("includes/theme/request-runtime.php")),
  false,
  "ThemeArtifact-only request pin must not survive the SiteRelease hard cut.",
);
for (const [path, text] of source) {
  assert.doesNotMatch(
    text,
    /\b(?:ThemeDeployment|zeroy_theme_checkout|zeroy_theme_push|theme_deployments|theme_state|bootstrap-site-logic|legacy_locale|legacy_theme_copy)\b/,
    `${path} retains a legacy production identity after the hard cut.`,
  );
}
process.stdout.write("zeroY SiteRelease boundary gate passed.\n");
