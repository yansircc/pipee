import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ProfileConnector } from "../../src/protocol/schema.js";
import type { LaunchedChrome } from "./chrome-process.ts";
import { waitForBrowserEvent } from "./cdp-client.ts";
import type { BoundSmokeConnector, FakeBridge } from "./fake-bridge.ts";
import {
  CONNECTOR_HEADERS,
  CONNECTOR_METADATA_HEADERS,
  type BridgeRequestChallenge,
  type ConnectorRequestRouteName,
  connectorRequestProofMessage,
  connectorServerProofMessage,
  decodeHandshake,
  freshAuthenticationToken,
  hashBridgeRequestBody,
  hmacProof,
  proofMatches,
  SMOKE_ROUTES,
} from "./protocol-fixture.ts";
import { VERSION_COMMAND } from "./scenario-fixture.ts";

const identityHeaders = (identity: ProfileConnector): Record<string, string> => ({
  [CONNECTOR_HEADERS.id]: identity.connectorId,
  [CONNECTOR_HEADERS.extensionId]: identity.extensionId,
  [CONNECTOR_METADATA_HEADERS.displayVersion]: identity.extensionDisplayVersion,
  [CONNECTOR_METADATA_HEADERS.protocolFingerprint]: identity.protocolFingerprint,
});

const issueChallenge = async (
  bridge: FakeBridge,
  identity: ProfileConnector,
): Promise<BridgeRequestChallenge> => {
  const clientNonce = freshAuthenticationToken();
  const route = SMOKE_ROUTES.connectorHandshake;
  const response = await fetch(`${bridge.url}${route.path}`, {
    method: route.method,
    headers: {
      ...identityHeaders(identity),
      [CONNECTOR_HEADERS.clientNonce]: clientNonce,
    },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const handshake = decodeHandshake(text);
  const challenge = {
    bridgeEpoch: handshake.bridgeEpoch,
    requestNonce: handshake.requestNonce,
  };
  const message = connectorServerProofMessage(
    "connectorServerProof",
    identity,
    clientNonce,
    challenge,
    handshake.protocolFingerprint,
  );
  assert.equal(proofMatches(identity.secret, message, handshake.proof), true);
  return challenge;
};

const forgedRequest = async (
  bridge: FakeBridge,
  identity: ProfileConnector,
  routeName: ConnectorRequestRouteName,
): Promise<void> => {
  const challenge = await issueChallenge(bridge, identity);
  const route = SMOKE_ROUTES[routeName];
  const body =
    routeName === "result"
      ? JSON.stringify({ id: VERSION_COMMAND.id, ok: true, value: { forged: true } })
      : "";
  const bodyHash = hashBridgeRequestBody(body);
  const proof = hmacProof(
    "0".repeat(identity.secret.length),
    connectorRequestProofMessage(
      "connectorRequestProof",
      identity,
      challenge,
      route.method,
      route.path,
      bodyHash,
    ),
  );
  const response = await fetch(`${bridge.url}${route.path}`, {
    method: route.method,
    headers: {
      ...identityHeaders(identity),
      [CONNECTOR_HEADERS.bridgeEpoch]: challenge.bridgeEpoch,
      [CONNECTOR_HEADERS.requestNonce]: challenge.requestNonce,
      [CONNECTOR_HEADERS.bodySha256]: bodyHash,
      [CONNECTOR_HEADERS.proof]: proof,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  assert.equal(response.status, 401, `${route.path} accepted a proof from the wrong secret`);
  await response.text();
};

export const exerciseAuthenticationAttacks = async (
  bridge: FakeBridge,
  identity: BoundSmokeConnector,
  chrome: LaunchedChrome,
): Promise<void> => {
  bridge.armInvalidServerProof();
  await waitForBrowserEvent(
    bridge,
    chrome,
    bridge.invalidServerProofRejected.promise,
    "connector rejection of an invalid bridge server proof",
    15_000,
  );

  const wrongIdentity = { ...identity, connectorId: randomUUID() };
  const handshake = SMOKE_ROUTES.connectorHandshake;
  const wrongIdentityResponse = await fetch(`${bridge.url}${handshake.path}`, {
    method: handshake.method,
    headers: {
      ...identityHeaders(wrongIdentity),
      [CONNECTOR_HEADERS.clientNonce]: freshAuthenticationToken(),
    },
  });
  assert.equal(wrongIdentityResponse.status, 401, "Handshake accepted a different connector id");
  await wrongIdentityResponse.text();

  await forgedRequest(bridge, identity, "poll");
  await forgedRequest(bridge, identity, "result");
  bridge.assertAuthenticationCoverage();
};
