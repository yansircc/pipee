import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const files = [];
const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else files.push(path);
  }
};
await visit(root);

const legacyContracts =
  /zeroy\/(?:post|term|site-copy|post-translation|term-translation|site-copy-translation)@1/u;
const forbiddenNames = /(?:^|\/)(?:post|post-locale)\.schema\.json$/u;
const violations = [];
for (const file of files) {
  const path = relative(root, file);
  if (forbiddenNames.test(path)) violations.push(`${path}: legacy generic schema artifact`);
  if (!/\.(?:php|ts|mjs|json|md)$/u.test(path)) continue;
  const source = await readFile(file, "utf8");
  if (legacyContracts.test(source)) violations.push(`${path}: legacy authored contract literal`);
  if (
    source.includes("translations/") &&
    ![
      "wordpress-plugin/includes/site-checkout/document-algebra.php",
      "scripts/localwp-site-checkout-acceptance.mjs",
      "scripts/verify-localized-document-hard-cut.mjs",
    ].includes(path)
  )
    violations.push(`${path}: legacy translations path surface`);
}
if (violations.length > 0) throw new Error(`zeroY hard-cut violations:\n${violations.join("\n")}`);
process.stdout.write("zeroY localized-document hard-cut gate passed.\n");
