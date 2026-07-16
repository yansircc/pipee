import assert from "node:assert/strict";
import { root, run } from "./lib.mjs";

assert.equal(process.platform, "darwin", "release:preflight requires Apple container on macOS");
assert.equal(
  run("git", ["status", "--porcelain"], { capture: true }),
  "",
  "release:preflight requires a clean committed worktree",
);

const sourceSha = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
assert.match(sourceSha, /^[0-9a-f]{40}$/);

const platform = process.env.PI_SUITE_PREFLIGHT_PLATFORM ?? "linux/arm64";
assert.match(platform, /^linux\/(?:arm64|amd64)$/, "unsupported preflight platform");

const containerScript = `
git clone --no-local --quiet /source /work/pi-suite
cd /work/pi-suite
git checkout --detach --quiet "$SOURCE_SHA"
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
test -z "$(git status --porcelain)"
corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm install --frozen-lockfile
node tooling/release/candidate-pipeline.mjs full "$SOURCE_SHA"
`;

const args = [
  "run",
  "--rm",
  "--platform",
  platform,
  ...(platform === "linux/amd64" ? ["--rosetta"] : []),
  "--mount",
  `type=bind,source=${root},target=/source,readonly`,
  "--env",
  `SOURCE_SHA=${sourceSha}`,
  "node:24-bookworm",
  "sh",
  "-euc",
  containerScript,
];

run("container", args);
process.stdout.write(`Linux candidate preflight passed for ${sourceSha} on ${platform}.\n`);
