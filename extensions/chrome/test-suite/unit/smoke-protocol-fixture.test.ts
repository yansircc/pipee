import { expect, it } from "vite-plus/test";
import {
  connectorRequestProofMessage as productionRequestProofMessage,
  connectorServerProofMessage as productionServerProofMessage,
} from "../../src/protocol/bridge-authentication.js";
import { BRIDGE_ROUTES } from "../../src/protocol/bridge-contract.js";
import { nodeHmacProof } from "../../src/pi/bridge-authentication-node.js";
import {
  connectorRequestProofMessage,
  connectorServerProofMessage,
  decodeProfileConnector,
  decodeWireResult,
  hmacProof,
} from "../../scripts/smoke/protocol-fixture.ts";

const identity = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  secret: "a".repeat(64),
  label: "Smoke Chrome",
  extensionId: "abcdefghijklmnopabcdefghijklmnop",
  extensionDisplayVersion: "0.16.0",
  protocolFingerprint: "b".repeat(64),
} as const;

const challenge = {
  bridgeEpoch: "c".repeat(64),
  requestNonce: "d".repeat(64),
} as const;

it("keeps the independent smoke HMAC fixture on the production canonical contract", () => {
  const fixtureServerMessage = connectorServerProofMessage(
    "connectorServerProof",
    identity,
    "e".repeat(64),
    challenge,
    identity.protocolFingerprint,
  );
  expect(fixtureServerMessage).toBe(
    productionServerProofMessage(
      "connectorServerProof",
      identity,
      "e".repeat(64),
      challenge,
      identity.protocolFingerprint,
    ),
  );

  const fixtureRequestMessage = connectorRequestProofMessage(
    "connectorRequestProof",
    identity,
    challenge,
    BRIDGE_ROUTES.result.method,
    BRIDGE_ROUTES.result.path,
    "f".repeat(64),
  );
  expect(fixtureRequestMessage).toBe(
    productionRequestProofMessage(
      "connectorRequestProof",
      identity,
      challenge,
      BRIDGE_ROUTES.result.method,
      BRIDGE_ROUTES.result.path,
      "f".repeat(64),
    ),
  );
  expect(hmacProof(identity.secret, fixtureRequestMessage)).toBe(
    nodeHmacProof(identity.secret, fixtureRequestMessage),
  );
});

it("decodes only complete profile identities and wire outcomes", () => {
  expect(decodeProfileConnector(identity)).toEqual(identity);
  expect(() => decodeProfileConnector({ ...identity, label: "" })).toThrow(
    "profile connector.label",
  );

  expect(decodeWireResult(JSON.stringify({ id: "ok", ok: true, value: { count: 1 } }))).toEqual({
    id: "ok",
    ok: true,
    value: { count: 1 },
  });
  expect(
    decodeWireResult(
      JSON.stringify({
        id: "unknown",
        ok: false,
        error: { _tag: "CommandOutcomeUnknown", message: "unknown", cause: "worker stopped" },
      }),
    ),
  ).toMatchObject({ ok: false, error: { _tag: "CommandOutcomeUnknown" } });
  expect(() => decodeWireResult(JSON.stringify({ id: "missing", ok: true }))).toThrow(
    "value is not JSON",
  );
});
