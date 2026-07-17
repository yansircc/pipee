import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  connectorRequestProofMessage,
  connectorServerProofMessage,
  type BridgeRequestChallenge,
  type ConnectorRequestProofDomain,
  type ConnectorServerProofDomain,
} from "../../src/protocol/bridge-authentication.js";
import { BRIDGE_ROUTES, type BridgeRouteName } from "../../src/protocol/bridge-contract.js";
import {
  CONNECTOR_BODY_SHA256_HEADER,
  CONNECTOR_BRIDGE_EPOCH_HEADER,
  CONNECTOR_CLIENT_NONCE_HEADER,
  CONNECTOR_DISPLAY_VERSION_METADATA_HEADER,
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_ID_HEADER,
  CONNECTOR_PROOF_HEADER,
  CONNECTOR_PROTOCOL_FINGERPRINT_HEADER,
  CONNECTOR_REQUEST_NONCE_HEADER,
  PAIRING_ID_HEADER,
} from "../../src/protocol/connector-auth.js";
import { decodeBridgeAuthenticationHandshakeJson } from "../../src/protocol/codec.js";
import type { ProfileConnector } from "../../src/protocol/schema.js";
import {
  freshAuthenticationToken,
  hashBridgeRequestBody,
  hasValidNodeHmacProof,
  nodeHmacProof,
} from "../../src/pi/bridge-authentication-node.js";

class BridgeAuthFixtureFailure extends Data.TaggedError("BridgeAuthFixtureFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const extensionIdentityHeaders = (connector: ProfileConnector): Record<string, string> => ({
  [CONNECTOR_ID_HEADER]: connector.connectorId,
  [CONNECTOR_EXTENSION_ID_HEADER]: connector.extensionId,
  [CONNECTOR_DISPLAY_VERSION_METADATA_HEADER]: connector.extensionDisplayVersion,
  [CONNECTOR_PROTOCOL_FINGERPRINT_HEADER]: connector.protocolFingerprint,
});

const httpRequest = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(url, { ...init, signal }).then((response) =>
        response.text().then((text) => ({ status: response.status, text })),
      ),
    catch: (cause) => new BridgeAuthFixtureFailure({ message: `request failed: ${url}`, cause }),
  });

const issueBridgeChallenge = (
  baseUrl: string,
  handshakeRoute: "connectorHandshake" | "pairingHandshake",
  serverDomain: ConnectorServerProofDomain,
  secret: string,
  connector: ProfileConnector,
  pairingId?: string,
) =>
  Effect.gen(function* () {
    const clientNonce = freshAuthenticationToken();
    const route = BRIDGE_ROUTES[handshakeRoute];
    const response = yield* httpRequest(`${baseUrl}${route.path}`, {
      method: route.method,
      headers: {
        ...extensionIdentityHeaders(connector),
        [CONNECTOR_CLIENT_NONCE_HEADER]: clientNonce,
        ...(handshakeRoute === "connectorHandshake" ? { "content-type": "application/json" } : {}),
        ...(pairingId ? { [PAIRING_ID_HEADER]: pairingId } : {}),
      },
      ...(handshakeRoute === "connectorHandshake" ? { body: JSON.stringify(connector) } : {}),
    });
    if (response.status !== 200) {
      return yield* new BridgeAuthFixtureFailure({
        message: `bridge handshake returned ${response.status}: ${response.text}`,
      });
    }
    const handshake = yield* decodeBridgeAuthenticationHandshakeJson(response.text);
    const challenge = {
      bridgeEpoch: handshake.bridgeEpoch,
      requestNonce: handshake.requestNonce,
    } satisfies BridgeRequestChallenge;
    const message = connectorServerProofMessage(
      serverDomain,
      connector,
      clientNonce,
      challenge,
      handshake.protocolFingerprint,
      pairingId,
    );
    if (!hasValidNodeHmacProof(secret, message, handshake.proof)) {
      return yield* new BridgeAuthFixtureFailure({ message: "bridge handshake proof is invalid" });
    }
    return { challenge, handshake } as const;
  });

const bridgeRequestProofHeaders = (
  routeName: BridgeRouteName,
  requestDomain: ConnectorRequestProofDomain,
  secret: string,
  connector: ProfileConnector,
  challenge: BridgeRequestChallenge,
  body: string,
  pairingId?: string,
): Record<string, string> => {
  const route = BRIDGE_ROUTES[routeName];
  const bodyHash = hashBridgeRequestBody(body);
  return {
    ...extensionIdentityHeaders(connector),
    [CONNECTOR_BRIDGE_EPOCH_HEADER]: challenge.bridgeEpoch,
    [CONNECTOR_REQUEST_NONCE_HEADER]: challenge.requestNonce,
    [CONNECTOR_BODY_SHA256_HEADER]: bodyHash,
    [CONNECTOR_PROOF_HEADER]: nodeHmacProof(
      secret,
      connectorRequestProofMessage(
        requestDomain,
        connector,
        challenge,
        route.method,
        route.path,
        bodyHash,
        pairingId,
      ),
    ),
    ...(pairingId ? { [PAIRING_ID_HEADER]: pairingId } : {}),
  };
};

export const authenticatedBridgeRequest = (
  baseUrl: string,
  handshakeRoute: "connectorHandshake" | "pairingHandshake",
  routeName: "poll" | "result" | "pairingConfirm",
  serverDomain: ConnectorServerProofDomain,
  requestDomain: ConnectorRequestProofDomain,
  secret: string,
  connector: ProfileConnector,
  body: string = "",
  pairingId?: string,
) =>
  Effect.gen(function* () {
    const { challenge } = yield* issueBridgeChallenge(
      baseUrl,
      handshakeRoute,
      serverDomain,
      secret,
      connector,
      pairingId,
    );
    const route = BRIDGE_ROUTES[routeName];
    return yield* httpRequest(`${baseUrl}${route.path}`, {
      method: route.method,
      headers: {
        ...bridgeRequestProofHeaders(
          routeName,
          requestDomain,
          secret,
          connector,
          challenge,
          body,
          pairingId,
        ),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
  });

export const pairingRequest = (
  baseUrl: string,
  capability: string,
  connector: ProfileConnector,
  pairingId?: string,
) =>
  authenticatedBridgeRequest(
    baseUrl,
    "pairingHandshake",
    "pairingConfirm",
    "pairingServerProof",
    "pairingRequestProof",
    capability,
    connector,
    JSON.stringify({ connector }),
    pairingId,
  );
