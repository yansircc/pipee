import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, root, run, suiteConfig } from "./lib.mjs";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";
import { bumpVersion, releaseBumpFromMessage } from "./version.mjs";

const sourceSha = process.argv[2];
if (!sourceSha) throw new Error("usage: prepare.mjs <source-sha>");

const git = (args, options = {}) => run("git", args, { capture: true, ...options }).trim();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const releaseCommits = () => {
  const records = git(["log", "origin/main", "--format=%H%x1f%P%x1f%B%x1e"]);
  return records.split("\x1e").flatMap((record) => {
    const [commit, rawParents = "", message = ""] = record.trim().split("\x1f", 3);
    if (!commit) return [];
    const parsed = parseReleaseRecord(message);
    if (parsed === undefined) return [];
    const parents = rawParents.split(/\s+/).filter(Boolean);
    const manifestVersions = versionsAt(commit);
    assertReleaseRecordCommit({ record: parsed, parents, manifestVersions });
    return [{ commit, source: parsed.source, version: parsed.version, bump: parsed.bump }];
  });
};
const manifestPaths = () => [
  "package.json",
  ...suiteConfig().packages.map(({ path }) => `${path}/package.json`),
];
const versionsAt = (commit) =>
  manifestPaths().map((path) => JSON.parse(git(["show", `${commit}:${path}`])).version);
const assertUnified = (versions, context) => {
  const expected = versions[0];
  if (!versions.every((version) => version === expected)) {
    throw new Error(`${context} does not have one Suite version: ${versions.join(", ")}`);
  }
  return expected;
};

git(["cat-file", "-e", `${sourceSha}^{commit}`]);
const releases = releaseCommits();
const matchingReleases = releases.filter(({ source }) => source === sourceSha);
if (matchingReleases.length > 1) throw new Error("one source commit has multiple release records");
const existing = matchingReleases[0];
if (existing) git(["checkout", "--detach", existing.commit]);
else if (git(["rev-parse", "HEAD"]) !== sourceSha) {
  throw new Error("new release preparation must run from the source commit");
}

const sourceMessage = git(["show", "-s", "--format=%B", sourceSha]);
const bump = releaseBumpFromMessage(sourceMessage);
const currentManifests = manifestPaths().map((path) => [path, readJson(path)]);
const currentVersion = assertUnified(
  currentManifests.map(([, manifest]) => manifest.version),
  existing ? "existing release" : "source",
);

if (!existing) {
  const previous = releases[0];
  if (previous) {
    const releasedVersion = assertUnified(versionsAt(previous.commit), "previous release");
    if (currentVersion !== releasedVersion) {
      throw new Error(
        `Suite version is CI-owned; expected ${releasedVersion}, received ${currentVersion}`,
      );
    }
  }
}

const version = existing ? currentVersion : bumpVersion(currentVersion, bump);
const releaseFiles = [];
if (!existing) {
  for (const [path, manifest] of currentManifests) {
    manifest.version = version;
    writeJson(resolve(root, path), manifest);
    releaseFiles.push(path);
  }
}

const tag = `suite-v${version}`;
if (!existing) {
  try {
    git(["rev-parse", "--verify", `refs/tags/${tag}`]);
    throw new Error(`release tag already exists: ${tag}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("release tag already exists"))
      throw error;
  }
}

const result = {
  mode: existing ? "existing" : "new",
  bump,
  version,
  tag,
  sourceSha,
  releaseFiles: releaseFiles.join(","),
  existingCommit: existing?.commit,
};
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(result)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
