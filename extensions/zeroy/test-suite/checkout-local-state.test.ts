import { describe, expect, it } from "vite-plus/test";
import { commitHash, type SiteCommit } from "../src/domain/site-objects.js";
import { decodeCheckoutDescriptor, decodePendingPush } from "../src/pi/checkout-tools.js";

const tree = `sha256:${"1".repeat(64)}` as const;
const commit: SiteCommit = {
  contract: "zeroy/site-commit@1",
  tree,
  parents: [],
  baseReleaseId: null,
  author: { principal: "site:test", actorSessionId: "session-test" },
  message: "checkpoint",
  createdAt: "2026-08-03T00:00:00.000Z",
};
const identity = commitHash(commit);
if (identity._tag === "Failure") throw new Error(identity.error.message);

const pending = {
  contract: "zeroy/pending-push@1",
  commandId: "12345678-1234-1234-1234-123456789abc",
  requestHash: "2".repeat(64),
  commitHash: identity.value,
  commit,
  expectedCommit: null,
  rootTree: tree,
  mode: "checkpoint",
  message: "checkpoint",
  changeSummary: {
    changedPathCount: 1,
    changedSubjectCount: 0,
    uploadedObjectCount: 1,
    uploadedBytes: 12,
  },
};

describe("zeroY local transport state", () => {
  it("accepts only a self-contained pending push bound to the exact commit", () => {
    expect(decodePendingPush(pending)).toEqual(pending);
    const { commit: _omitted, ...withoutCommit } = pending;
    expect(decodePendingPush(withoutCommit)).toBeNull();
    expect(decodePendingPush({ ...pending, rootTree: `sha256:${"3".repeat(64)}` })).toBeNull();
    expect(
      decodePendingPush({
        ...pending,
        commit: { ...commit, message: "different immutable commit" },
      }),
    ).toBeNull();
  });

  it("rejects checkout descriptors with shadow or malformed state", () => {
    const descriptor = {
      contract: "zeroy/checkout@1",
      siteId: "site-test",
      checkoutId: "checkout-test",
      remoteRef: "refs/drafts/connector/12345678-1234-1234-1234-123456789abc",
      observedCommit: identity.value,
      expectedRefCommit: identity.value,
      baseReleaseId: null,
      materializedAt: "2026-08-03T00:00:00.000Z",
    };
    expect(decodeCheckoutDescriptor(descriptor)).toEqual(descriptor);
    expect(decodeCheckoutDescriptor({ ...descriptor, revision: 7 })).toBeNull();
    expect(decodeCheckoutDescriptor({ ...descriptor, remoteRef: "refs/heads/main" })).toBeNull();
  });
});
