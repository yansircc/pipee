import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertPipeeBrand } from "./brand-contract.mjs";
import { root } from "./lib.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

for (const relative of files) {
  const bytes = readFileSync(resolve(root, relative));
  if (bytes.includes(0)) continue;
  assertPipeeBrand(relative, `path ${relative}`);
  assertPipeeBrand(bytes.toString("utf8"), `file ${relative}`);
}

process.stdout.write(`Verified Pipee branding across ${files.length} repository files.\n`);
