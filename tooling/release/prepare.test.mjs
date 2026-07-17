import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const projectRoot = new URL("../../", import.meta.url).pathname;
const packageEntries = [
  { id: "web", name: "@fixture/web", path: "apps/web", version: "0.1.8" },
  { id: "loop", name: "@fixture/loop", path: "extensions/loop", version: "0.5.7" },
  { id: "chrome", name: "@fixture/chrome", path: "extensions/chrome", version: "0.1.6" },
];
const run = (cwd, command, args) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => run(cwd, "git", args);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const makeRepository = ({ withChanges = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pi-suite-release-test-"));
  const remote = `${root}-remote.git`;
  git(tmpdir(), "init", "--bare", remote);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "release-test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "config", "commit.gpgSign", "false");
  git(root, "remote", "add", "origin", remote);
  symlinkSync(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "tooling", "release"), { recursive: true });
  mkdirSync(join(root, "release", "changes"), { recursive: true });
  for (const file of [
    "build-candidates.mjs",
    "create-release-record.mjs",
    "lib.mjs",
    "prepare.mjs",
    "release-plan.mjs",
    "release-record.mjs",
    "version.mjs",
  ]) {
    cpSync(join(projectRoot, "tooling", "release", file), join(root, "tooling", "release", file));
  }
  writeJson(join(root, "release", "suite.config.json"), {
    schemaVersion: 1,
    packages: packageEntries.map(({ version: _version, ...entry }) => entry),
  });
  for (const entry of packageEntries) {
    mkdirSync(join(root, entry.path), { recursive: true });
    writeJson(join(root, entry.path, "package.json"), { name: entry.name, version: entry.version });
  }
  writeJson(join(root, "package.json"), {
    name: "@fixture/suite",
    version: "0.0.0",
    private: true,
  });
  if (withChanges) {
    writeJson(join(root, "release", "changes", "web-chrome.json"), {
      schemaVersion: 1,
      changes: [
        { package: "@fixture/web", bump: "minor" },
        { package: "@fixture/chrome", bump: "patch" },
      ],
    });
  }
  writeFileSync(
    join(root, ".gitignore"),
    "node_modules/\nrelease/candidate.json\nrelease/candidates/\n",
  );
  return { root, remote };
};
const commitAll = (root, message) => {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
};
const prepare = (root, sourceSha) =>
  JSON.parse(run(root, process.execPath, ["tooling/release/prepare.mjs", sourceSha]));
const version = (root, id) => {
  const entry = packageEntries.find((candidate) => candidate.id === id);
  return JSON.parse(readFileSync(join(root, entry.path, "package.json"), "utf8")).version;
};

it("versions and packs only the explicit public release set", () => {
  const fixture = makeRepository();
  try {
    const source = commitAll(fixture.root, "feat: independent release");
    git(fixture.root, "push", "-u", "origin", "main");
    const result = prepare(fixture.root, source);
    assert.equal(result.mode, "new");
    assert.deepEqual(
      result.packages.map(({ id, version, bump }) => ({ id, version, bump })),
      [
        { id: "web", version: "0.2.0", bump: "minor" },
        { id: "chrome", version: "0.1.7", bump: "patch" },
      ],
    );
    assert.equal(version(fixture.root, "loop"), "0.5.7");
    run(fixture.root, process.execPath, [
      "tooling/release/build-candidates.mjs",
      "--prepared-source",
      source,
    ]);
    const candidate = JSON.parse(
      readFileSync(join(fixture.root, "release", "candidate.json"), "utf8"),
    );
    assert.equal(candidate.schemaVersion, 4);
    assert.deepEqual(Object.keys(candidate.artifacts), ["web", "chrome"]);
    assert.deepEqual(
      candidate.projection.packages.map(({ id, fromVersion, toVersion }) => ({
        id,
        fromVersion,
        toVersion,
      })),
      [
        { id: "web", fromVersion: "0.1.8", toVersion: "0.2.0" },
        { id: "chrome", fromVersion: "0.1.6", toVersion: "0.1.7" },
      ],
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});

it("reuses one independent release record and rejects later manual version drift", () => {
  const fixture = makeRepository();
  try {
    const source = commitAll(fixture.root, "feat: independent release");
    git(fixture.root, "push", "-u", "origin", "main");
    prepare(fixture.root, source);
    run(fixture.root, process.execPath, [
      "tooling/release/build-candidates.mjs",
      "--prepared-source",
      source,
    ]);
    run(fixture.root, process.execPath, ["tooling/release/create-release-record.mjs", source]);
    git(fixture.root, "push", "origin", "main", "--tags");
    git(fixture.root, "checkout", "--detach", source);
    assert.equal(prepare(fixture.root, source).mode, "existing");

    git(fixture.root, "checkout", "main");
    writeJson(join(fixture.root, "extensions", "loop", "package.json"), {
      name: "@fixture/loop",
      version: "9.0.0",
    });
    const drifted = commitAll(fixture.root, "feat: drift");
    git(fixture.root, "push", "origin", "main");
    assert.throws(() => prepare(fixture.root, drifted), /loop version is CI-owned/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});

it("returns a no-release transition when no changeset exists", () => {
  const fixture = makeRepository({ withChanges: false });
  try {
    const source = commitAll(fixture.root, "docs: no package release");
    git(fixture.root, "push", "-u", "origin", "main");
    const result = prepare(fixture.root, source);
    assert.equal(result.mode, "none");
    assert.deepEqual(result.packages, []);
    assert.equal(git(fixture.root, "status", "--porcelain"), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});
