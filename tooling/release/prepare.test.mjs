import assert from "node:assert/strict";
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
import { execFileSync } from "node:child_process";

const projectRoot = new URL("../../", import.meta.url).pathname;
const packagePaths = ["apps/web", "extensions/loop", "extensions/weixin", "extensions/chrome"];
const run = (cwd, command, args) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => run(cwd, "git", args);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const makeRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-suite-release-test-"));
  const remote = `${root}-remote.git`;
  git(tmpdir(), "init", "--bare", remote);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "release-test");
  git(root, "config", "user.email", "release-test@example.invalid");
  git(root, "remote", "add", "origin", remote);
  symlinkSync(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(root, "tooling", "release"), { recursive: true });
  mkdirSync(join(root, "release"), { recursive: true });
  for (const file of ["build-candidates.mjs", "lib.mjs", "prepare.mjs", "release-record.mjs", "version.mjs"]) {
    cpSync(join(projectRoot, "tooling", "release", file), join(root, "tooling", "release", file));
  }
  writeJson(join(root, "release", "suite.config.json"), {
    schemaVersion: 1,
    packages: packagePaths.map((path, index) => ({
      id: String(index),
      name: `@fixture/package-${index}`,
      path,
    })),
  });
  for (const [index, path] of packagePaths.entries()) {
    mkdirSync(join(root, path), { recursive: true });
    writeJson(join(root, path, "package.json"), {
      name: `@fixture/package-${index}`,
      version: "0.5.7",
    });
  }
  writeJson(join(root, "package.json"), {
    name: "@fixture/suite",
    version: "0.5.7",
    private: true,
  });
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
const versions = (root) =>
  ["package.json", ...packagePaths.map((path) => `${path}/package.json`)].map(
    (path) => JSON.parse(readFileSync(join(root, path), "utf8")).version,
  );

it("updates the whole Suite once and reuses the release for the same source", () => {
  const fixture = makeRepository();
  try {
    const source = commitAll(fixture.root, "feat: first suite\n\nRelease-Bump: minor");
    git(fixture.root, "push", "-u", "origin", "main");
    assert.deepEqual(prepare(fixture.root, source), {
      mode: "new",
      bump: "minor",
      version: "0.6.0",
      tag: "suite-v0.6.0",
      sourceSha: source,
      releaseFiles:
        "package.json,apps/web/package.json,extensions/loop/package.json,extensions/weixin/package.json,extensions/chrome/package.json",
    });
    assert.deepEqual(versions(fixture.root), Array(5).fill("0.6.0"));
    run(fixture.root, process.execPath, [
      "tooling/release/build-candidates.mjs",
      "--prepared-source",
      source,
    ]);
    const candidate = JSON.parse(
      readFileSync(join(fixture.root, "release", "candidate.json"), "utf8"),
    );
    assert.deepEqual(
      {
        schemaVersion: candidate.schemaVersion,
        sourceSha: candidate.sourceSha,
        releasable: candidate.releasable,
        projection: candidate.projection,
      },
      {
        schemaVersion: 3,
        sourceSha: source,
        releasable: true,
        projection: {
          kind: "suite-version",
          files: [
            "apps/web/package.json",
            "extensions/chrome/package.json",
            "extensions/loop/package.json",
            "extensions/weixin/package.json",
            "package.json",
          ],
          version: "0.6.0",
        },
      },
    );
    for (const artifact of Object.values(candidate.artifacts)) {
      assert.equal(artifact.version, "0.6.0");
      assert.match(artifact.integrity, /^sha512-/);
    }
    commitAll(
      fixture.root,
      `chore(release): suite-v0.6.0\n\nRelease-Source: ${source}\n\nRelease-Bump: minor`,
    );
    git(fixture.root, "push", "origin", "main");
    git(fixture.root, "checkout", "--detach", source);
    assert.match(JSON.stringify(prepare(fixture.root, source)), /"mode":"existing"/);
    assert.deepEqual(versions(fixture.root), Array(5).fill("0.6.0"));
    assert.throws(
      () =>
        run(fixture.root, process.execPath, [
          "tooling/release/build-candidates.mjs",
          "--existing-release",
          source,
        ]),
      /must restore its witnessed candidate/,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.root, "release", "candidate.json"), "utf8")),
      candidate,
      "existing release must leave the first candidate untouched",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});

it("rejects source-side drift from the previous unified release version", () => {
  const fixture = makeRepository();
  try {
    const first = commitAll(fixture.root, "feat: first");
    git(fixture.root, "push", "-u", "origin", "main");
    prepare(fixture.root, first);
    commitAll(
      fixture.root,
      `chore(release): suite-v0.5.8\n\nRelease-Source: ${first}\n\nRelease-Bump: patch`,
    );
    git(fixture.root, "push", "origin", "main");
    writeJson(join(fixture.root, "extensions", "loop", "package.json"), {
      name: "@fixture/package-1",
      version: "9.0.0",
    });
    const drifted = commitAll(fixture.root, "feat: drift");
    git(fixture.root, "push", "origin", "main");
    assert.throws(() => prepare(fixture.root, drifted), /does not have one Suite version/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});

it("rejects a superseded source before building a release candidate", () => {
  const fixture = makeRepository();
  try {
    const first = commitAll(fixture.root, "feat: first");
    git(fixture.root, "push", "-u", "origin", "main");
    writeFileSync(join(fixture.root, "change.txt"), "second\n");
    commitAll(fixture.root, "feat: second");
    git(fixture.root, "push", "origin", "main");
    git(fixture.root, "checkout", "--detach", first);
    assert.throws(() => prepare(fixture.root, first), /source is no longer origin\/main/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.remote, { recursive: true, force: true });
  }
});
