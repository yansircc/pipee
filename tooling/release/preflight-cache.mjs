import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const preflightCachePrefix = "pi-suite-pnpm-";
export const preflightBaseImage = "node:24-bookworm";
export const preflightImageFile = (root) =>
  resolve(root, "tooling/release/preflight-image/Dockerfile");

export const preflightLockHash = (lockFile) =>
  createHash("sha256").update(readFileSync(lockFile)).digest("hex").slice(0, 20);

export const preflightImageHash = ({ imageFile, baseImageDigest }) =>
  createHash("sha256")
    .update(readFileSync(imageFile))
    .update("\0")
    .update(baseImageDigest)
    .digest("hex")
    .slice(0, 16);

export const preflightStoreVolume = ({ architecture, lockHash, imageHash }) =>
  `${preflightCachePrefix}${architecture}-${lockHash}-${imageHash}`;

export const obsoletePreflightVolumes = ({ volumeNames, currentVolume, referencedVolumes }) =>
  volumeNames
    .filter((name) => name.startsWith(preflightCachePrefix))
    .filter((name) => name !== currentVolume && !referencedVolumes.has(name))
    .sort();
