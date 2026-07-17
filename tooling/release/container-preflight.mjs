import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { root, run } from "./lib.mjs";

assert.equal(process.platform, "darwin", "release:preflight requires Apple container on macOS");
assert.equal(
  run("git", ["status", "--porcelain"], { capture: true }),
  "",
  "release:preflight requires a clean committed worktree",
);

const sourceSha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/);
const mainSha = run("git", ["rev-parse", "refs/remotes/origin/main"], {
  capture: true,
}).trim();
assert.match(mainSha, /^[0-9a-f]{40}$/);
run("git", ["merge-base", "--is-ancestor", mainSha, sourceSha]);
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
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const imageDirectory = resolve(root, "tooling/release/preflight-image");
const imageFile = resolve(imageDirectory, "Dockerfile");
const baseImage = "node:24-bookworm";
if (spawnSync("container", ["image", "inspect", baseImage]).status !== 0)
  run("container", ["image", "pull", baseImage]);
const baseImageDescriptor = JSON.parse(
  run("container", ["image", "inspect", baseImage], { capture: true }),
)[0].configuration.descriptor.digest;
assert.match(baseImageDescriptor, /^sha256:[0-9a-f]{64}$/, "preflight base image has no descriptor digest");
const imageHash = createHash("sha256")
  .update(readFileSync(imageFile))
  .update("\0")
  .update(baseImageDescriptor)
  .digest("hex")
  .slice(0, 16);
const image = `pi-suite-preflight:${imageHash}-${architecture}`;
if (spawnSync("container", ["image", "inspect", image]).status !== 0) {
  run("container", [
    "build",
    "--platform",
    platform,
    "--cpus",
    cpus,
    "--memory",
    memory,
    "--file",
    imageFile,
    "--tag",
    image,
    dirname(imageFile),
  ]);
}

const lockHash = hashFile(resolve(root, "pnpm-lock.yaml")).slice(0, 20);
const storeVolume = `pi-suite-pnpm-${architecture}-${lockHash}`;
if (spawnSync("container", ["volume", "inspect", storeVolume]).status !== 0)
  run("container", ["volume", "create", storeVolume]);

const containerScript = `
git clone --quiet /input/source.bundle /work/pi-suite
cd /work/pi-suite
git fetch --quiet /input/source.bundle refs/remotes/origin/main:refs/remotes/origin/main
git checkout --detach --quiet "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test "$(git rev-parse refs/remotes/origin/main)" = "$MAIN_SHA"
test -z "$(git status --porcelain)"
test "$(node --version | cut -d. -f1)" = "v24"
test "$(pnpm --version)" = "11.13.1"
pnpm config set store-dir /pnpm-store
if test ! -f /pnpm-store/.fetch-complete; then
  pnpm fetch --frozen-lockfile
  touch /pnpm-store/.fetch-complete
fi
pnpm install --offline --frozen-lockfile
PI_SUITE_RELEASE_PREVIEW=1 node tooling/release/candidate-pipeline.mjs full "$SOURCE_SHA"
`;

const bundleDirectory = mkdtempSync(join(tmpdir(), "pi-suite-preflight-source-"));
const bundlePath = join(bundleDirectory, "source.bundle");
run("git", ["bundle", "create", bundlePath, "HEAD", "refs/remotes/origin/main"]);
run("git", ["bundle", "verify", bundlePath], { capture: true });

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
  `type=bind,source=${bundleDirectory},target=/input,readonly`,
  "--mount",
  `type=volume,source=${storeVolume},target=/pnpm-store`,
  "--env",
  `SOURCE_SHA=${sourceSha}`,
  "--env",
  `MAIN_SHA=${mainSha}`,
  image,
  "sh",
  "-euc",
  containerScript,
];

try {
  run("container", args);
} finally {
  rmSync(bundleDirectory, { recursive: true, force: true });
}
process.stdout.write(`Linux candidate preflight passed for ${sourceSha} on ${platform}.\n`);
