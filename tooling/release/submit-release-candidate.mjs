import { execFileSync } from "node:child_process";

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();

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
