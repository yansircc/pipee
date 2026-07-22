import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCheckoutLease, acquireVerifyLease } from "./verify-lease.mjs";

test("serializes verification owners within one checkout", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pipee-verify-lease-"));
  try {
    const releaseFirst = await acquireVerifyLease(workspaceRoot);
    let secondAcquired = false;
    const second = acquireVerifyLease(workspaceRoot).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(secondAcquired, false);

    await releaseFirst();
    const releaseSecond = await second;
    assert.equal(secondAcquired, true);
    await releaseSecond();
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("keeps independent checkout resources concurrent", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pipee-resource-lease-"));
  try {
    const [releaseVerify, releaseE2e] = await Promise.all([
      acquireCheckoutLease(workspaceRoot, "verify"),
      acquireCheckoutLease(workspaceRoot, "e2e"),
    ]);
    await Promise.all([releaseVerify(), releaseE2e()]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
