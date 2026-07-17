import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { root, run } from "./lib.mjs";

assert.equal(process.platform, "darwin", "release:preflight requires Apple container on macOS");
assert.equal(
  run("git", ["status", "--porcelain"], { capture: true }),
  "",
  "release:preflight requires a clean committed worktree",
);

const sourceSha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/);
run("pnpm", ["--filter", "@yansircc/pi-chrome", "run", "release:check"]);
assert.equal(
  run("git", ["status", "--porcelain"], { capture: true }),
  "",
  "Chrome connector verification changed the worktree",
);

const platform = process.env.PI_SUITE_PREFLIGHT_PLATFORM ?? "linux/arm64";
assert.match(platform, /^linux\/(?:arm64|amd64)$/, "unsupported preflight platform");
const cpus = process.env.PI_SUITE_PREFLIGHT_CPUS ?? "8";
const memory = process.env.PI_SUITE_PREFLIGHT_MEMORY ?? "8G";
assert.match(cpus, /^[1-9]\d*$/, "preflight CPUs must be a positive integer");
assert.match(memory, /^[1-9]\d*[GM]$/, "preflight memory must use a positive G or M value");
const architecture = platform.slice("linux/".length);
const storeVolume = `pi-suite-pnpm-store-${architecture}`;
if (spawnSync("container", ["volume", "inspect", storeVolume]).status !== 0)
  run("container", ["volume", "create", storeVolume]);

const containerScript = `
git clone --no-local --quiet /source /work/pi-suite
cd /work/pi-suite
git checkout --detach --quiet "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"
export COREPACK_HOME=/pnpm-store/corepack
corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm config set store-dir /pnpm-store
pnpm install --frozen-lockfile
node tooling/release/candidate-pipeline.mjs full "$SOURCE_SHA"
`;

const args = [
  "run",
  "--rm",
  "--platform",
  platform,
  "--cpus",
  cpus,
  "--memory",
  memory,
  ...(platform === "linux/amd64" ? ["--rosetta"] : []),
  "--mount",
  `type=bind,source=${root},target=/source,readonly`,
  "--mount",
  `type=volume,source=${storeVolume},target=/pnpm-store`,
  "--env",
  `SOURCE_SHA=${sourceSha}`,
  "node:24-bookworm",
  "sh",
  "-euc",
  containerScript,
];

run("container", args);
process.stdout.write(`Linux candidate preflight passed for ${sourceSha} on ${platform}.\n`);
