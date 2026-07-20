import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (command, args, options = {}) => {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
};

const controlPlane = [
  ".github/workflows/release-candidate.yml",
  ".github/workflows/release-promote.yml",
];

run("git", ["fetch", "origin", "main"], { inherit: true });
for (const path of controlPlane) {
  assert.equal(
    run("git", ["diff", "--name-only", "refs/remotes/origin/main", "HEAD", "--", path]),
    "",
    `${path} differs from origin/main; publish the release control plane before creating an immutable candidate`,
  );
}

const candidate = JSON.parse(run(process.execPath, ["tooling/release/materialize-release-candidate.mjs"]));
run("git", ["push", "origin", `${candidate.ref}:${candidate.ref}`], { inherit: true });
run(
  "gh",
  [
    "workflow",
    "run",
    "release-candidate.yml",
    "--ref",
    "main",
    "-f",
    `release_sha=${candidate.release}`,
  ],
  { inherit: true },
);
process.stdout.write(`Submitted ${candidate.release} for CI release witnessing.\n`);
