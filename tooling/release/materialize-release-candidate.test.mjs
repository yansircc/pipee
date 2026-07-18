import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const projectRoot = new URL("../../", import.meta.url).pathname;
const run = (cwd, command, args) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => run(cwd, "git", args);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-suite-materialize-test-"));
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
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  for (const file of [
    "lib.mjs",
    "classify.mjs",
    "materialize-release-candidate.mjs",
    "release-plan.mjs",
    "release-record.mjs",
    "version.mjs",
  ]) {
    cpSync(join(projectRoot, "tooling", "release", file), join(root, "tooling", "release", file));
  }
  writeJson(join(root, "release", "suite.config.json"), {
    schemaVersion: 1,
    packages: [{ id: "web", name: "@yansircc/pi-web", path: "apps/web" }],
  });
  writeJson(join(root, "apps", "web", "package.json"), {
    name: "@yansircc/pi-web",
    version: "1.2.3",
  });
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "chore: base");
  git(root, "push", "-u", "origin", "main");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "feature.txt"), "candidate\n");
  writeJson(join(root, "release", "changes", "web.json"), {
    schemaVersion: 1,
    changes: [{ package: "@yansircc/pi-web", bump: "minor" }],
  });
  git(root, "add", "-A");
  git(root, "commit", "-m", "feat: candidate");
  return { root, remote, base, source: git(root, "rev-parse", "HEAD") };
};

it("materializes one witnessed merge commit without changing the development branch", () => {
  const value = fixture();
  try {
    const result = JSON.parse(
      run(value.root, process.execPath, ["tooling/release/materialize-release-candidate.mjs"]),
    );
    assert.equal(result.base, value.base);
    assert.equal(result.source, value.source);
    assert.equal(git(value.root, "rev-parse", "HEAD"), value.source);
    assert.equal(git(value.root, "status", "--porcelain"), "");
    assert.equal(git(value.root, "show", "-s", "--format=%P", result.release), `${value.base} ${value.source}`);
    assert.equal(
      JSON.parse(git(value.root, "show", `${result.release}:apps/web/package.json`)).version,
      "1.3.0",
    );
    assert.throws(() => git(value.root, "show", `${result.release}:release/changes/web.json`));
    assert.equal(git(value.root, "show", `${result.release}:feature.txt`), "candidate");
    assert.equal(git(value.root, "rev-parse", result.ref), result.release);
    assert.equal(
      run(value.root, process.execPath, ["tooling/release/classify.mjs", result.release]),
      "true",
    );
    const repeated = JSON.parse(
      run(value.root, process.execPath, ["tooling/release/materialize-release-candidate.mjs"]),
    );
    assert.equal(repeated.release, result.release);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

it("rejects development-owned public version drift", () => {
  const value = fixture();
  try {
    writeJson(join(value.root, "apps", "web", "package.json"), {
      name: "@yansircc/pi-web",
      version: "9.0.0",
    });
    git(value.root, "add", "-A");
    git(value.root, "commit", "-m", "feat: drift version");
    assert.throws(
      () => run(value.root, process.execPath, ["tooling/release/materialize-release-candidate.mjs"]),
      /version is release-owned/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});
