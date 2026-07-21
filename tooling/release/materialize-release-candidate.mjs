import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleasePlan } from "./release-plan.mjs";
import { bumpVersion } from "./version.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const git = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const pipeeConfig = () =>
  JSON.parse(readFileSync(resolve(root, "release/pipee.config.json"), "utf8"));

assert.equal(git(["status", "--porcelain"]), "", "release candidate requires a clean worktree");
const source = git(["rev-parse", "HEAD"]);
const base = git(["rev-parse", "refs/remotes/origin/main"]);
git(["merge-base", "--is-ancestor", base, source]);

const plan = readReleasePlan();
assert.ok(plan.packages.length > 0, "release candidate requires at least one release changeset");
const config = pipeeConfig();
for (const entry of config.packages) {
  const path = `${entry.path}/package.json`;
  let baseManifest;
  try {
    baseManifest = JSON.parse(git(["show", `${base}:${path}`]));
  } catch {
    continue;
  }
  const sourceManifest = JSON.parse(git(["show", `${source}:${path}`]));
  assert.equal(
    sourceManifest.version,
    baseManifest.version,
    `${entry.id} version is release-owned and changed in development source`,
  );
}
const temporary = mkdtempSync(join(tmpdir(), "pipee-release-candidate-"));
try {
  git(["worktree", "add", "--detach", temporary, source]);
  const packages = plan.packages.map((entry) => {
    const path = resolve(temporary, entry.path, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const fromVersion = manifest.version;
    const version = bumpVersion(fromVersion, entry.bump);
    manifest.version = version;
    writeJson(path, manifest);
    return { id: entry.id, version, bump: entry.bump };
  });
  for (const file of plan.files) rmSync(resolve(temporary, file));
  git(["add", "--", ...plan.packages.map(({ path }) => `${path}/package.json`), ...plan.files], {
    cwd: temporary,
  });
  const staged = git(["diff", "--cached", "--name-status"], { cwd: temporary });
  assert.ok(staged.length > 0, "release candidate tree has no projection changes");
  const tree = git(["write-tree"], { cwd: temporary });
  const message = [
    `chore(release): release-${source.slice(0, 12)}`,
    "",
    `Release-Source: ${source}`,
    "",
    `Release-Base: ${base}`,
    ...packages.flatMap((entry) => [
      "",
      `Release-Package: ${entry.id} ${entry.version} ${entry.bump}`,
    ]),
  ].join("\n");
  const messagePath = resolve(temporary, ".git-release-message");
  writeFileSync(messagePath, `${message}\n`);
  const releaseDate = git(["show", "-s", "--format=%cI", source]);
  const release = git(["commit-tree", tree, "-p", source, "-F", messagePath], {
    cwd: temporary,
    env: {
      GIT_AUTHOR_NAME: "github-actions[bot]",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_AUTHOR_DATE: releaseDate,
      GIT_COMMITTER_NAME: "github-actions[bot]",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_DATE: releaseDate,
    },
  });
  const ref = `refs/heads/release-candidates/${release}`;
  git(["update-ref", ref, release]);
  process.stdout.write(`${JSON.stringify({ source, base, release, ref, packages }, null, 2)}\n`);
} finally {
  try {
    git(["worktree", "remove", "--force", temporary]);
  } catch {
    rmSync(temporary, { recursive: true, force: true });
  }
}
