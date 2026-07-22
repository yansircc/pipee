import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export const acquireCheckoutLease = async (workspaceRoot, name) => {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid checkout lease name: ${name}`);
  const leaseDirectory = join(workspaceRoot, "node_modules");
  const leaseTarget = join(leaseDirectory, `.pipee-${name}`);
  await mkdir(leaseDirectory, { recursive: true });
  await writeFile(leaseTarget, "", { flag: "a" });
  return lockfile.lock(leaseTarget, {
    realpath: false,
    retries: {
      forever: true,
      factor: 1.2,
      minTimeout: 100,
      maxTimeout: 1_000,
      randomize: true,
    },
    stale: 60_000,
    update: 10_000,
  });
};

export const acquireVerifyLease = (workspaceRoot) => acquireCheckoutLease(workspaceRoot, "verify");
