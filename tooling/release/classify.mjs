import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

const commit = process.argv[2];
if (!commit) throw new Error("usage: classify.mjs <commit>");
const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const record = parseReleaseRecord(git(["show", "-s", "--format=%B", commit]));

if (record !== undefined) {
  const parents = git(["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean);
  const packages = JSON.parse(git(["show", `${commit}:release/pipee.config.json`])).packages;
  const packageManifestPaths = Object.fromEntries(
    packages.map(({ id, path }) => [id, `${path}/package.json`]),
  );
  const manifestVersions = Object.fromEntries(
    packages.map(({ id, path }) => [
      id,
      JSON.parse(git(["show", `${commit}:${path}/package.json`])).version,
    ]),
  );
  assertReleaseRecordCommit({
    record,
    parents,
    manifestVersions,
    sourceManifestVersions: Object.fromEntries(
      packages.map(({ id, path }) => [
        id,
        JSON.parse(git(["show", `${record.source}:${path}/package.json`])).version,
      ]),
    ),
    packageIds: packages.map(({ id }) => id),
    packageManifestPaths,
    changedFiles: git(["diff", "--name-status", record.source, commit])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return { status, path };
      }),
  });
}

const result = record === undefined ? "false" : "true";
const sourceRelease =
  record === undefined &&
  (() => {
    try {
      return execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "release/changes"], {
        cwd: root,
        encoding: "utf8",
      })
        .split(/\r?\n/)
        .some((path) => path.endsWith(".json"));
    } catch {
      return false;
    }
  })();
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `release_commit=${result}\nsource_release=${sourceRelease ? "true" : "false"}\n`,
  );
}
process.stdout.write(`${result}\n`);
