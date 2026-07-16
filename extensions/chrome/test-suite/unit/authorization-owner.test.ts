import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";
import {
  AUTHORIZATION_ENTRY_TYPE,
  AuthorizationOwner,
  restoreAuthorizationOwnerFromSession,
} from "../../src/pi/authorization-owner.js";

const generationSequence = () => {
  let value = 0;
  return () => `00000000-0000-4000-8000-${(++value).toString(16).padStart(12, "0")}`;
};

const branchLedger = (initial: ReadonlyArray<SessionEntry> = []) => {
  const branch = [...initial];
  const append = (data: unknown) => {
    const previous = branch.at(-1);
    branch.push({
      type: "custom",
      customType: AUTHORIZATION_ENTRY_TYPE,
      data,
      id: `entry-${branch.length + 1}`,
      parentId: previous?.id ?? null,
      timestamp: new Date(branch.length + 1).toISOString(),
    });
  };
  return { branch, append };
};

it("reconstructs timed, background, and revoked state across runtime instances", () => {
  const ledger = branchLedger();
  const first = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 1_000,
    makeGeneration: generationSequence(),
  });
  expect(first.reason).toBe("new");
  expect(first.owner.current).toMatchObject({
    authorization: { state: "locked" },
    background: false,
  });
  expect(first.owner.isAuthorized(1_000)).toBe(false);

  first.owner.authorize({ state: "timed", deadline: 10_000 });
  first.owner.setBackground(true);
  const resumed = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 2_000,
    makeGeneration: generationSequence(),
  });
  expect(resumed.reason).toBe("restored");
  expect(resumed.owner.current).toMatchObject({
    authorization: { state: "timed", deadline: 10_000 },
    background: true,
  });

  resumed.owner.lock();
  const restarted = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 3_000,
    makeGeneration: generationSequence(),
  });
  expect(restarted.owner.current).toMatchObject({
    authorization: { state: "locked" },
    background: true,
  });
  expect(JSON.stringify(ledger.branch)).not.toContain("secret");
});

it("fails closed on the newest matching entry instead of falling back to older authorization", () => {
  const ledger = branchLedger();
  const initial = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 1_000,
    makeGeneration: generationSequence(),
  });
  initial.owner.authorize({ state: "indefinite" });
  expect(initial.owner.isAuthorized(1_000)).toBe(true);
  ledger.append({ ...initial.owner.current, unexpected: "must not be stripped" });

  const recovered = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 2_000,
    makeGeneration: generationSequence(),
  });

  expect(recovered.reason).toBe("invalid");
  expect(recovered.owner.current.authorization).toEqual({ state: "locked" });
  expect(recovered.owner.isAuthorized(2_000)).toBe(false);
  expect(ledger.branch.at(-1)).toMatchObject({
    type: "custom",
    data: { version: 1, authorization: { state: "locked" }, background: false },
  });
});

it("prevents an old expiry from overwriting reauthorization or a newer projection", () => {
  const ledger = branchLedger();
  const { owner } = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: ledger.append,
    now: 0,
    makeGeneration: generationSequence(),
  });
  owner.authorize({ state: "timed", deadline: 1_000 });
  const obsolete = owner.expiryClaim()!;
  owner.authorize({ state: "indefinite" });

  expect(owner.expireIfCurrent(obsolete, 1_000)).toBe(false);
  expect(owner.current.authorization).toEqual({ state: "indefinite" });

  owner.authorize({ state: "timed", deadline: 2_000 });
  const beforeBackgroundChange = owner.expiryClaim()!;
  owner.setBackground(true);
  expect(owner.expireIfCurrent(beforeBackgroundChange, 2_000)).toBe(false);
  const current = owner.expiryClaim()!;
  expect(owner.expireIfCurrent(current, 2_000)).toBe(true);
  expect(owner.current).toMatchObject({ authorization: { state: "locked" }, background: true });
});

it("does not project an authorization transition that failed to append", () => {
  const ledger = branchLedger();
  let rejectAppend = false;
  const { owner } = AuthorizationOwner.restore({
    branch: ledger.branch,
    append: (entry) => {
      if (rejectAppend) throw new Error("ledger unavailable");
      ledger.append(entry);
    },
    now: 0,
    makeGeneration: generationSequence(),
  });
  rejectAppend = true;

  expect(() => owner.authorize({ state: "indefinite" })).toThrow("ledger unavailable");
  expect(owner.current.authorization).toEqual({ state: "locked" });
});

it("repairs a poisoned runtime only by appending a fresh canonical lock", () => {
  const ledger = branchLedger();
  const repaired = AuthorizationOwner.repairLocked({
    append: ledger.append,
    background: true,
    makeGeneration: generationSequence(),
  });

  expect(repaired.current).toMatchObject({
    version: 1,
    authorization: { state: "locked" },
    background: true,
  });
  expect(ledger.branch.at(-1)).toMatchObject({
    type: "custom",
    customType: AUTHORIZATION_ENTRY_TYPE,
    data: repaired.current,
  });
});

it("reconstructs authorization from the current branch and locks a branch with no entry", () => {
  const generation = generationSequence();
  const lockedBranch = branchLedger();
  const lockedOwner = AuthorizationOwner.restore({
    branch: lockedBranch.branch,
    append: lockedBranch.append,
    now: 0,
    makeGeneration: generation,
  }).owner;
  lockedOwner.lock();

  const authorizedBranch = branchLedger();
  const authorizedOwner = AuthorizationOwner.restore({
    branch: authorizedBranch.branch,
    append: authorizedBranch.append,
    now: 0,
    makeGeneration: generation,
  }).owner;
  authorizedOwner.authorize({ state: "indefinite" });

  const allEntries = [...lockedBranch.branch, ...authorizedBranch.branch];
  const restoredLocked = restoreAuthorizationOwnerFromSession({
    session: {
      getBranch: () => lockedBranch.branch,
      getEntries: () => allEntries,
    },
    append: lockedBranch.append,
    now: 1,
    makeGeneration: generation,
  });
  const restoredAuthorized = restoreAuthorizationOwnerFromSession({
    session: {
      getBranch: () => authorizedBranch.branch,
      getEntries: () => allEntries,
    },
    append: authorizedBranch.append,
    now: 1,
    makeGeneration: generation,
  });
  expect(restoredLocked.owner.current.authorization).toEqual({ state: "locked" });
  expect(restoredAuthorized.owner.current.authorization).toEqual({ state: "indefinite" });

  const missingBranch = branchLedger();
  const missing = AuthorizationOwner.restore({
    branch: missingBranch.branch,
    append: missingBranch.append,
    sessionHasAuthorizationEntry: true,
    now: 1,
    makeGeneration: generation,
  });
  expect(missing.reason).toBe("missing");
  expect(missing.owner.current.authorization).toEqual({ state: "locked" });
});

it("canonicalizes an expired deadline without losing background state", () => {
  const generation = generationSequence();
  const currentBranch = branchLedger();
  const currentOwner = AuthorizationOwner.restore({
    branch: currentBranch.branch,
    append: currentBranch.append,
    now: 0,
    makeGeneration: generation,
  }).owner;
  currentOwner.authorize({ state: "timed", deadline: 100 });
  currentOwner.setBackground(true);

  const restored = AuthorizationOwner.restore({
    branch: currentBranch.branch,
    append: currentBranch.append,
    now: 100,
    makeGeneration: generation,
  });
  expect(restored.reason).toBe("expired");
  expect(restored.owner.current).toMatchObject({
    authorization: { state: "locked" },
    background: true,
  });
});
