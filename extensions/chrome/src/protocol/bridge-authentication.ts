import { HMAC_AUTHENTICATION } from "./bridge-contract.js";

export type BridgeRequestChallenge = {
  readonly bridgeEpoch: string;
  readonly requestNonce: string;
};

export type HmacAuthenticationDomain = keyof typeof HMAC_AUTHENTICATION.domains;
export type ConnectorServerProofDomain = Extract<HmacAuthenticationDomain, "connectorServerProof">;
export type ConnectorRequestProofDomain = Extract<
  HmacAuthenticationDomain,
  "connectorRequestProof"
>;

export type ConnectorProofIdentity = {
  readonly connectorId: string;
  readonly extensionId: string;
  readonly extensionDisplayVersion: string;
  readonly protocolFingerprint: string;
};

const canonical = (parts: ReadonlyArray<string>): string => JSON.stringify(parts);

export const serverProofMessage = (
  domain: HmacAuthenticationDomain,
  identity: ReadonlyArray<string>,
  clientNonce: string,
  challenge: BridgeRequestChallenge,
  serverProtocolFingerprint: string,
): string =>
  canonical([
    HMAC_AUTHENTICATION.domains[domain],
    String(HMAC_AUTHENTICATION.algorithmVersion),
    ...identity,
    clientNonce,
    challenge.bridgeEpoch,
    challenge.requestNonce,
    serverProtocolFingerprint,
  ]);

export const requestProofMessage = (
  domain: HmacAuthenticationDomain,
  identity: ReadonlyArray<string>,
  challenge: BridgeRequestChallenge,
  clientProtocolFingerprint: string,
  method: string,
  path: string,
  bodyHash: string,
): string =>
  canonical([
    HMAC_AUTHENTICATION.domains[domain],
    String(HMAC_AUTHENTICATION.algorithmVersion),
    ...identity,
    challenge.bridgeEpoch,
    challenge.requestNonce,
    clientProtocolFingerprint,
    method,
    path,
    bodyHash,
  ]);

const connectorProofIdentity = (identity: ConnectorProofIdentity): ReadonlyArray<string> => [
  identity.connectorId,
  identity.extensionId,
  identity.extensionDisplayVersion,
  identity.protocolFingerprint,
];

export const connectorServerProofMessage = (
  domain: ConnectorServerProofDomain,
  identity: ConnectorProofIdentity,
  clientNonce: string,
  challenge: BridgeRequestChallenge,
  serverProtocolFingerprint: string,
): string =>
  serverProofMessage(
    domain,
    connectorProofIdentity(identity),
    clientNonce,
    challenge,
    serverProtocolFingerprint,
  );

export const connectorRequestProofMessage = (
  domain: ConnectorRequestProofDomain,
  identity: ConnectorProofIdentity,
  challenge: BridgeRequestChallenge,
  method: string,
  path: string,
  bodyHash: string,
): string =>
  requestProofMessage(
    domain,
    connectorProofIdentity(identity),
    challenge,
    identity.protocolFingerprint,
    method,
    path,
    bodyHash,
  );

const protocolContractChallenge = {
  bridgeEpoch: "bridge-epoch",
  requestNonce: "request-nonce",
} as const;
const protocolContractConnector = {
  connectorId: "connector-id",
  extensionId: "extension-id",
  extensionDisplayVersion: "extension-display-version",
  protocolFingerprint: "client-protocol-fingerprint",
} as const;

export const authenticationMessageProtocolContract = {
  ownerServerProof: serverProofMessage(
    "ownerServerProof",
    [],
    "client-nonce",
    protocolContractChallenge,
    "server-protocol-fingerprint",
  ),
  ownerRequestProof: requestProofMessage(
    "ownerRequestProof",
    [],
    protocolContractChallenge,
    "client-protocol-fingerprint",
    "METHOD",
    "/path",
    "body-hash",
  ),
  connectorServerProof: connectorServerProofMessage(
    "connectorServerProof",
    protocolContractConnector,
    "client-nonce",
    protocolContractChallenge,
    "server-protocol-fingerprint",
  ),
  connectorRequestProof: connectorRequestProofMessage(
    "connectorRequestProof",
    protocolContractConnector,
    protocolContractChallenge,
    "METHOD",
    "/path",
    "body-hash",
  ),
} as const;

export const decodeHex = (value: string): Uint8Array | undefined => {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    return undefined;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const encodeHex = (value: ArrayBuffer | Uint8Array): string =>
  Array.from(value instanceof Uint8Array ? value : new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
