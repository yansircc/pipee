import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const preflightCachePrefix = "pi-suite-pnpm-";
export const preflightBaseImage = "node:24-bookworm";
export const preflightImageFile = (root) =>
  resolve(root, "tooling/release/preflight-image/Dockerfile");

export const preflightFileHash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 20);

export const preflightImageHash = ({ imageFile, baseImageDigest }) =>
  createHash("sha256")
    .update(readFileSync(imageFile))
    .update("\0")
    .update(baseImageDigest)
    .digest("hex")
    .slice(0, 16);

export const preflightStoreVolume = ({ architecture, lockHash, workspaceHash, imageHash }) =>
  `${preflightCachePrefix}${architecture}-${lockHash}-${workspaceHash}-${imageHash}`;

export const obsoletePreflightVolumes = ({ volumeNames, currentVolume, referencedVolumes }) =>
  volumeNames
    .filter((name) => name.startsWith(preflightCachePrefix))
    .filter((name) => name !== currentVolume && !referencedVolumes.has(name))
    .sort();
