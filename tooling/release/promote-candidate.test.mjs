import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { it } from "node:test";

const projectRoot = new URL("../../", import.meta.url).pathname;
const run = (cwd, command, args) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => run(cwd, "git", args);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const integrity = (path) =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

const makeCandidate = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-suite-promoter-test-"));
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
  mkdirSync(join(root, "apps", "pipee"), { recursive: true });
  for (const file of [
    "lib.mjs",
    "materialize-release-candidate.mjs",
    "promote-candidate.mjs",
    "registry-state.mjs",
    "release-plan.mjs",
    "release-record.mjs",
    "version.mjs",
  ]) {
    cpSync(join(projectRoot, "tooling", "release", file), join(root, "tooling", "release", file));
  }
  writeJson(join(root, "release", "suite.config.json"), {
    schemaVersion: 1,
    packages: [{ id: "web", name: "@yansircc/pipee", path: "apps/pipee" }],
  });
  writeJson(join(root, "apps", "pipee", "package.json"), {
    name: "@yansircc/pipee",
    version: "1.2.3",
    type: "module",
    files: ["index.js"],
  });
  writeFileSync(join(root, "apps", "pipee", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\nrelease/candidate.json\nrelease/candidates/\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "chore: base");
  git(root, "push", "-u", "origin", "main");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "apps", "pipee", "index.js"), "export const value = 2;\n");
  writeJson(join(root, "release", "changes", "web.json"), {
    schemaVersion: 1,
    changes: [{ package: "@yansircc/pipee", bump: "minor" }],
  });
  git(root, "add", "-A");
  git(root, "commit", "-m", "feat: candidate");
  const source = git(root, "rev-parse", "HEAD");
  const materialized = JSON.parse(
    run(root, process.execPath, ["tooling/release/materialize-release-candidate.mjs"]),
  );

  const packageRoot = mkdtempSync(join(tmpdir(), "pi-suite-promoter-package-"));
  writeFileSync(join(packageRoot, "package.json"), git(root, "show", `${materialized.release}:apps/pipee/package.json`));
  writeFileSync(join(packageRoot, "index.js"), git(root, "show", `${materialized.release}:apps/pipee/index.js`));
  mkdirSync(join(root, "release", "candidates"), { recursive: true });
  const archiveName = basename(
    run(packageRoot, "npm", ["pack", "--pack-destination", join(root, "release", "candidates")]),
  );
  rmSync(packageRoot, { recursive: true, force: true });
  const archive = join(root, "release", "candidates", archiveName);
  writeJson(join(root, "release", "candidate.json"), {
    schemaVersion: 5,
    sourceSha: source,
    releaseSha: materialized.release,
    releasable: true,
    projection: {
      kind: "release-record",
      releaseSha: materialized.release,
      baseSha: base,
      releaseTag: `release-${source.slice(0, 12)}`,
      packages: [
        {
          id: "web",
          name: "@yansircc/pipee",
          bump: "minor",
          fromVersion: "1.2.3",
          toVersion: "1.3.0",
          tag: "pipee-v1.3.0",
        },
      ],
    },
    artifacts: {
      web: {
        name: "@yansircc/pipee",
        version: "1.3.0",
        archive: archiveName,
        integrity: integrity(archive),
      },
    },
  });
  return { root, remote, base, release: materialized.release, archive };
};

it("verifies release identity and npm archive bytes without candidate dependencies", () => {
  const value = makeCandidate();
  try {
    assert.match(
      run(value.root, process.execPath, [
        "tooling/release/promote-candidate.mjs",
        "verify",
        "release",
        value.release,
        value.base,
      ]),
      /Verified privileged boundary/,
    );
    writeFileSync(value.archive, "corrupt");
    assert.throws(
      () =>
        run(value.root, process.execPath, [
          "tooling/release/promote-candidate.mjs",
          "verify",
          "release",
          value.release,
          value.base,
        ]),
      /archive bytes drifted/,
    );
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});

it("resumes an already-promoted candidate only before a later public release", () => {
  const value = makeCandidate();
  const promote = () =>
    run(value.root, process.execPath, [
      "tooling/release/promote-candidate.mjs",
      "promote",
      "release",
      value.release,
      value.base,
    ]);
  const verify = () =>
    run(value.root, process.execPath, [
      "tooling/release/promote-candidate.mjs",
      "verify",
      "release",
      value.release,
      value.base,
    ]);
  try {
    assert.match(promote(), /Promoted exact release commit/);
    git(value.root, "checkout", "--detach", value.release);
    writeFileSync(join(value.root, "RECOVERY.md"), "release recovery control plane\n");
    git(value.root, "add", "RECOVERY.md");
    git(value.root, "commit", "-m", "fix: recover release publication");
    git(value.root, "push", "origin", "HEAD:main");
    git(value.root, "fetch", "origin", "main");
    assert.match(verify(), /Verified privileged boundary/);
    assert.match(promote(), /already promoted on main/);

    const manifestPath = join(value.root, "apps", "pipee", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "1.4.0";
    writeJson(manifestPath, manifest);
    git(value.root, "add", manifestPath);
    git(value.root, "commit", "-m", "chore: later release");
    git(value.root, "push", "origin", "HEAD:main");
    git(value.root, "fetch", "origin", "main");
    assert.throws(verify, /main contains a later public package release/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
    rmSync(value.remote, { recursive: true, force: true });
  }
});
