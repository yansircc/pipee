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
  mkdirSync(join(root, "apps", "web"), { recursive: true });
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
    packages: [{ id: "web", name: "@yansircc/pi-web", path: "apps/web" }],
  });
  writeJson(join(root, "apps", "web", "package.json"), {
    name: "@yansircc/pi-web",
    version: "1.2.3",
    type: "module",
    files: ["index.js"],
  });
  writeFileSync(join(root, "apps", "web", "index.js"), "export const value = 1;\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\nrelease/candidate.json\nrelease/candidates/\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "chore: base");
  git(root, "push", "-u", "origin", "main");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "apps", "web", "index.js"), "export const value = 2;\n");
  writeJson(join(root, "release", "changes", "web.json"), {
    schemaVersion: 1,
    changes: [{ package: "@yansircc/pi-web", bump: "minor" }],
  });
  git(root, "add", "-A");
  git(root, "commit", "-m", "feat: candidate");
  const source = git(root, "rev-parse", "HEAD");
  const materialized = JSON.parse(
    run(root, process.execPath, ["tooling/release/materialize-release-candidate.mjs"]),
  );

  const packageRoot = mkdtempSync(join(tmpdir(), "pi-suite-promoter-package-"));
  writeFileSync(join(packageRoot, "package.json"), git(root, "show", `${materialized.release}:apps/web/package.json`));
  writeFileSync(join(packageRoot, "index.js"), git(root, "show", `${materialized.release}:apps/web/index.js`));
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
          name: "@yansircc/pi-web",
          bump: "minor",
          fromVersion: "1.2.3",
          toVersion: "1.3.0",
          tag: "pi-web-v1.3.0",
        },
      ],
    },
    artifacts: {
      web: {
        name: "@yansircc/pi-web",
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
