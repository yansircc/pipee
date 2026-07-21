import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseReleaseRecord, assertReleaseRecordCommit } from "./release-record.mjs";
import { classifyRegistryLookup, publicationDecision } from "./registry-state.mjs";

const [command, releaseRootArg, releaseSha, trustedMain] = process.argv.slice(2);
const releaseRoot = resolve(releaseRootArg ?? "release");
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const run = (program, args, options = {}) =>
  execFileSync(program, args, { encoding: "utf8", stdio: options.inherit ? "inherit" : undefined });
const readGitJson = (commit, path) => JSON.parse(git(["show", `${commit}:${path}`]));
const isAncestor = (ancestor, descendant) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    stdio: "ignore",
  }).status === 0;
const sha512 = (path) =>
  `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;

const verify = () => {
  assert.match(releaseSha ?? "", /^[0-9a-f]{40}$/, "promotion requires a release SHA");
  assert.match(trustedMain ?? "", /^[0-9a-f]{40}$/, "promotion requires its trusted main SHA");
  const currentMain = git(["rev-parse", "refs/remotes/origin/main"]);
  const resumedAfterPromotion = currentMain !== releaseSha && isAncestor(releaseSha, currentMain);
  assert.ok(
    currentMain === trustedMain || currentMain === releaseSha || resumedAfterPromotion,
    "main moved outside the candidate release lineage after candidate workflow dispatch",
  );
  const parents = git(["show", "-s", "--format=%P", releaseSha]).split(/\s+/);
  const record = parseReleaseRecord(git(["show", "-s", "--format=%B", releaseSha]));
  assert.ok(record, "release commit has no release record");
  assert.equal(record.base, trustedMain, "release candidate was built from another main");
  git(["merge-base", "--is-ancestor", record.base, record.source]);

  const config = readGitJson(releaseSha, "release/pipee.config.json");
  assert.equal(config.schemaVersion, 1, "Pipee release config schema is unsupported");
  assert.ok(Array.isArray(config.packages), "Pipee release config has no packages");
  const entries = new Map();
  const packageNames = new Set();
  const packagePaths = new Set();
  for (const entry of config.packages) {
    assert.match(entry.id, /^[a-z][a-z0-9-]*$/, "invalid public package id");
    assert.match(entry.name, /^@yansircc\/[a-z0-9-]+$/, "invalid public package name");
    assert.match(entry.path, /^(?:apps|extensions)\/[a-z0-9-]+$/, "invalid public package path");
    assert.equal(entries.has(entry.id), false, "duplicate public package id");
    assert.equal(packageNames.has(entry.name), false, "duplicate public package name");
    assert.equal(packagePaths.has(entry.path), false, "duplicate public package path");
    entries.set(entry.id, entry);
    packageNames.add(entry.name);
    packagePaths.add(entry.path);
  }
  const manifestVersions = Object.fromEntries(
    [...entries].map(([id, entry]) => [
      id,
      readGitJson(releaseSha, `${entry.path}/package.json`).version,
    ]),
  );
  if (resumedAfterPromotion) {
    assert.deepEqual(
      Object.fromEntries(
        [...entries].map(([id, entry]) => [
          id,
          readGitJson(currentMain, `${entry.path}/package.json`).version,
        ]),
      ),
      manifestVersions,
      "main contains a later public package release and cannot resume this candidate",
    );
  }
  assertReleaseRecordCommit({
    record,
    parents,
    manifestVersions,
    sourceManifestVersions: Object.fromEntries(
      [...entries].map(([id, entry]) => [
        id,
        readGitJson(record.source, `${entry.path}/package.json`).version,
      ]),
    ),
    packageIds: [...entries.keys()],
    packageManifestPaths: Object.fromEntries(
      [...entries].map(([id, entry]) => [id, `${entry.path}/package.json`]),
    ),
    changedFiles: git(["diff", "--name-status", record.source, releaseSha])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split("\t");
        return { status, path };
      }),
  });

  const candidate = JSON.parse(readFileSync(resolve(releaseRoot, "candidate.json"), "utf8"));
  assert.equal(candidate.schemaVersion, 5, "candidate schema is unsupported");
  assert.equal(candidate.releasable, true, "candidate is not releasable");
  assert.equal(candidate.releaseSha, releaseSha, "candidate belongs to another release commit");
  assert.equal(candidate.sourceSha, record.source, "candidate source drifted");
  assert.equal(candidate.projection?.kind, "release-record", "candidate projection is unsupported");
  assert.equal(candidate.projection.baseSha, record.base, "candidate base drifted");
  assert.equal(candidate.projection.releaseTag, record.tag, "candidate release tag drifted");
  assert.deepEqual(
    candidate.projection.packages.map(({ id, toVersion, bump }) => ({
      id,
      version: toVersion,
      bump,
    })),
    record.packages,
    "candidate package projection differs from the release record",
  );
  assert.deepEqual(
    Object.keys(candidate.artifacts).sort(),
    record.packages.map(({ id }) => id).sort(),
    "candidate archive set differs from the release record",
  );
  const archiveNames = new Set();
  for (const projected of candidate.projection.packages) {
    const entry = entries.get(projected.id);
    const artifact = candidate.artifacts[projected.id];
    assert.equal(artifact.name, entry.name, `${projected.id} archive name drifted`);
    assert.equal(artifact.version, projected.toVersion, `${projected.id} archive version drifted`);
    assert.equal(
      projected.tag,
      `${entry.name.split("/").at(-1)}-v${projected.toVersion}`,
      `${projected.id} package tag drifted`,
    );
    assert.equal(
      basename(artifact.archive),
      artifact.archive,
      "candidate archive name is not flat",
    );
    assert.match(artifact.archive, /^[a-z0-9][a-z0-9._-]*\.tgz$/, "invalid candidate archive name");
    assert.equal(archiveNames.has(artifact.archive), false, "candidate repeats an archive name");
    archiveNames.add(artifact.archive);
    const archive = resolve(releaseRoot, "candidates", artifact.archive);
    assert.equal(sha512(archive), artifact.integrity, `${projected.id} archive bytes drifted`);
    const inspection = spawnSync(
      "npm",
      ["pack", archive, "--dry-run", "--json", "--ignore-scripts"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.equal(
      inspection.status,
      0,
      `cannot inspect ${projected.id} archive: ${inspection.stderr}`,
    );
    const packed = JSON.parse(inspection.stdout);
    assert.equal(packed.length, 1, `${projected.id} archive inspection is ambiguous`);
    assert.equal(packed[0].name, artifact.name, `${projected.id} packed name drifted`);
    assert.equal(packed[0].version, artifact.version, `${projected.id} packed version drifted`);
    assert.equal(packed[0].integrity, artifact.integrity, `${projected.id} npm integrity drifted`);
  }
  return { candidate, currentMain, record };
};

const writeOutputs = ({ candidate, record }) => {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `release_sha=${releaseSha}`,
    `source_sha=${record.source}`,
    `base_sha=${record.base}`,
    `release_tag=${record.tag}`,
    `package_count=${candidate.projection.packages.length}`,
  ];
  for (const line of lines) assert.doesNotMatch(line, /[\r\n]/);
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
};

if (command === "verify") {
  const result = verify();
  writeOutputs(result);
  process.stdout.write(`Verified privileged boundary for ${releaseSha}.\n`);
} else if (command === "promote") {
  const { candidate, currentMain, record } = verify();
  if (currentMain !== record.base) {
    process.stdout.write(`Exact release ${releaseSha} is already promoted on main.\n`);
    process.exit(0);
  }
  const refs = [
    `${releaseSha}:refs/heads/main`,
    `${releaseSha}:refs/tags/${record.tag}`,
    ...candidate.projection.packages.map(({ tag }) => `${releaseSha}:refs/tags/${tag}`),
  ];
  run("git", ["push", "--atomic", "origin", ...refs], { inherit: true });
  process.stdout.write(`Promoted exact release commit ${releaseSha}.\n`);
} else if (command === "persist") {
  const { candidate, record } = verify();
  const assets = [
    resolve(releaseRoot, "candidate.json"),
    ...candidate.projection.packages.map(({ id }) =>
      resolve(releaseRoot, "candidates", candidate.artifacts[id].archive),
    ),
  ];
  const existing = spawnSync("gh", ["release", "view", record.tag], { encoding: "utf8" });
  if (existing.status !== 0) {
    run(
      "gh",
      [
        "release",
        "create",
        record.tag,
        "--verify-tag",
        "--title",
        record.tag,
        "--notes",
        `Exact Pipee candidate for ${releaseSha}`,
      ],
      { inherit: true },
    );
  }
  for (const asset of assets) {
    const name = basename(asset);
    const listed = run("gh", [
      "release",
      "view",
      record.tag,
      "--json",
      "assets",
      "--jq",
      ".assets[].name",
    ]);
    if (listed.split(/\r?\n/).includes(name)) {
      const temporary = mkdtempSync(join(tmpdir(), "pipee-persisted-"));
      try {
        run("gh", ["release", "download", record.tag, "--pattern", name, "--dir", temporary]);
        assert.deepEqual(
          readFileSync(join(temporary, name)),
          readFileSync(asset),
          `${name} persisted bytes drifted`,
        );
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    } else {
      run("gh", ["release", "upload", record.tag, asset], { inherit: true });
    }
  }
  process.stdout.write(`Persisted exact release assets for ${releaseSha}.\n`);
} else if (command === "publish") {
  const { candidate } = verify();
  for (const projected of candidate.projection.packages) {
    const artifact = candidate.artifacts[projected.id];
    const lookup = classifyRegistryLookup(
      spawnSync(
        "npm",
        ["view", `${artifact.name}@${artifact.version}`, "dist.integrity", "--json"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    if (publicationDecision(lookup, artifact.integrity)._tag === "Publish") {
      run(
        "npm",
        [
          "publish",
          resolve(releaseRoot, "candidates", artifact.archive),
          "--access",
          "public",
          "--provenance",
          "--ignore-scripts",
        ],
        { inherit: true },
      );
    }
  }
  process.stdout.write(`Published or exactly reused ${releaseSha}.\n`);
} else {
  throw new Error(
    "usage: promote-candidate.mjs verify|promote|persist|publish <release-root> <release-sha> <trusted-main>",
  );
}
