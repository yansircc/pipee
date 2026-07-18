import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const suiteConfig = () => readJson("release/suite.config.json");

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
  const packages = suiteConfig().packages;
  const packageManifestPaths = Object.fromEntries(
    packages.map(({ id, path }) => [id, `${path}/package.json`]),
  );
  const manifestVersions = Object.fromEntries(
    packages.map(({ id, path }) => [id, readJson(`${path}/package.json`).version]),
  );
  assertReleaseRecordCommit({
    record,
    parents,
    manifestVersions,
    packageIds: packages.map(({ id }) => id),
    packageManifestPaths,
    changedFiles: git(["diff-tree", "--no-commit-id", "--name-status", "-r", commit])
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
