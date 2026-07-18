import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  obsoletePreflightVolumes,
  preflightBaseImage,
  preflightImageFile,
  preflightImageHash,
  preflightLockHash,
  preflightStoreVolume,
} from "./preflight-cache.mjs";
import { root, run } from "./lib.mjs";

assert.equal(process.platform, "darwin", "release:preflight:gc requires Apple container on macOS");

const platform = process.env.PI_SUITE_PREFLIGHT_PLATFORM ?? "linux/arm64";
assert.match(platform, /^linux\/(?:arm64|amd64)$/, "unsupported preflight platform");
const architecture = platform.slice("linux/".length);
const lockHash = preflightLockHash(resolve(root, "pnpm-lock.yaml"));
const inspectedBaseImage = spawnSync("container", ["image", "inspect", preflightBaseImage], {
  encoding: "utf8",
});
const currentVolume =
  inspectedBaseImage.status === 0
    ? preflightStoreVolume({
        architecture,
        lockHash,
        imageHash: preflightImageHash({
          imageFile: preflightImageFile(root),
          baseImageDigest: JSON.parse(inspectedBaseImage.stdout)[0].configuration.descriptor.digest,
        }),
      })
    : null;
const volumeNames = run("container", ["volume", "ls", "--quiet"], { capture: true })
  .split(/\r?\n/)
  .filter(Boolean);
const containers = JSON.parse(
  run("container", ["list", "--all", "--format", "json"], { capture: true }),
);
const referencedVolumes = new Set(
  containers.flatMap(({ configuration }) =>
    (configuration.mounts ?? []).map(({ source }) => source).filter(Boolean),
  ),
);
const obsolete = obsoletePreflightVolumes({ volumeNames, currentVolume, referencedVolumes });

if (obsolete.length > 0) run("container", ["volume", "rm", ...obsolete]);
process.stdout.write(
  `Removed ${obsolete.length} obsolete preflight cache volume${obsolete.length === 1 ? "" : "s"}; current and referenced volumes were preserved.\n`,
);
