import { expect, it } from "@effect/vitest";
import {
  BridgeAuthenticationSession,
  BridgeChallengeRegistry,
  hashBridgeRequestBody,
  hasValidOwnerRequestProof,
  hasValidOwnerServerProof,
  ownerRequestProof,
  ownerServerProof,
} from "../../src/pi/bridge-authentication-node.js";
import { BRIDGE_ROUTES } from "../../src/protocol/bridge-contract.js";

const identity = {
  credential: "a".repeat(64),
  protocolFingerprint: "b".repeat(64),
} as const;

const challenge = {
  bridgeEpoch: "c".repeat(64),
  requestNonce: "d".repeat(64),
} as const;

const request = {
  ...challenge,
  method: BRIDGE_ROUTES.command.method,
  path: BRIDGE_ROUTES.command.path,
  bodyHash: hashBridgeRequestBody("body"),
} as const;

it("binds owner proofs to the credential, epoch, request, and body", () => {
  const serverProof = ownerServerProof(identity, "e".repeat(64), challenge);
  expect(hasValidOwnerServerProof(identity, "e".repeat(64), challenge, serverProof)).toBe(true);
  expect(hasValidOwnerServerProof(identity, "f".repeat(64), challenge, serverProof)).toBe(false);

  const proof = ownerRequestProof(identity, request);
  expect(hasValidOwnerRequestProof(identity, request, proof)).toBe(true);
  for (const changed of [
    { ...request, bridgeEpoch: "0".repeat(64) },
    { ...request, requestNonce: "1".repeat(64) },
    { ...request, method: BRIDGE_ROUTES.status.method },
    { ...request, path: BRIDGE_ROUTES.status.path },
    { ...request, bodyHash: hashBridgeRequestBody("changed") },
  ]) {
    expect(hasValidOwnerRequestProof(identity, changed, proof)).toBe(false);
  }
  expect(
    hasValidOwnerRequestProof({ ...identity, credential: "0".repeat(64) }, request, proof),
  ).toBe(false);
});

it("bounds, expires, and consumes issued owner challenges exactly once", () => {
  let sequence = 0;
  const registry = new BridgeChallengeRegistry(2, 10, () =>
    (sequence++).toString(16).padStart(64, "0"),
  );

  const evicted = registry.issue(0);
  const first = registry.issue(0);
  const second = registry.issue(0);
  expect(registry.pruneAndCount(0)).toBe(2);
  expect(registry.consume(evicted, 0)).toBe(false);
  expect(registry.consume(first, 0)).toBe(true);
  expect(registry.consume(first, 0)).toBe(false);
  expect(registry.consume(second, 10)).toBe(false);
  expect(registry.pruneAndCount(10)).toBe(0);
});

it("binds one-time challenges to one authentication session and scope", () => {
  const session = new BridgeAuthenticationSession();
  const challenge = session.issue("owner", 0);
  const proof = {
    ...challenge,
    bodyHash: hashBridgeRequestBody(""),
    proof: "e".repeat(64),
  };

  expect(session.authorize("connector", proof, 0)._tag).toBe("Unavailable");
  expect(session.authorize("owner", proof, 0)._tag).toBe("Accepted");
  expect(session.authorize("owner", proof, 0)._tag).toBe("Unavailable");

  const next = session.issue("owner", 0);
  expect(
    session.authorize("owner", { ...proof, ...next, bridgeEpoch: "0".repeat(64) }, 0)._tag,
  ).toBe("Malformed");
});
