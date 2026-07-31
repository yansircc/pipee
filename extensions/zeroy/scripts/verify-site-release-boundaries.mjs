import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const [pluginFiles, themeFiles] = await Promise.all([
  list(join(root, "wordpress-plugin")),
  list(join(root, "mvp-theme")),
]);
const source = await Promise.all(
  [...pluginFiles, ...themeFiles]
    .filter((path) => path.endsWith(".php"))
    .map(async (path) => [relative(root, path), await readFile(path, "utf8")]),
);
const theme = source.filter(
  ([path]) => path.startsWith("mvp-theme/") || path.includes("/stable-shell/"),
);
const connector = source.filter(([path]) => path.startsWith("wordpress-plugin/includes/"));
const siteLogic = source.filter(
  ([path]) => path.includes("/bootstrap-site-logic/") || path.includes("/site-logic/"),
);
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
  if (path.endsWith("site-release/migration.php")) continue;
  assert.doesNotMatch(
    text,
    /\b(?:ThemeDeployment|zeroy_theme_checkout|zeroy_theme_push|theme_deployments|theme_state)\b/,
    `${path} retains a legacy ThemeDeployment production identity after the hard cut.`,
  );
}
process.stdout.write("zeroY SiteRelease boundary gate passed.\n");
