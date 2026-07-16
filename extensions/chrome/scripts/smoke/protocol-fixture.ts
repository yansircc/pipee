import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BinaryToTextEncoding } from "node:crypto";
import bridge from "../../src/protocol/bridge.json" with { type: "json" };
import connectorAuth from "../../src/protocol/connector-auth.json" with { type: "json" };
import type {
  BridgeAuthenticationHandshake,
  ProfileConnector,
  WireResult,
} from "../../src/protocol/schema.js";
import type { JsonValue } from "../../src/protocol/json-value.js";
import { SmokeFailure } from "./support.ts";

export const BRIDGE_HOST = bridge.host;
export const BRIDGE_PORT = bridge.port;
const HMAC_AUTHENTICATION = bridge.hmacAuthentication;
export const RESULT_DELIVERY_POLICY = bridge.resultDelivery;
export const EXTENSION_PUBLIC_KEY = connectorAuth.extensionPublicKey;
export const CONNECTOR_HEADERS = connectorAuth.headers;
export const CONNECTOR_METADATA_HEADERS = connectorAuth.metadataHeaders;
export const CONNECTOR_REQUEST_HEADERS = [
  "content-type",
  ...Object.values(CONNECTOR_HEADERS),
  ...Object.values(CONNECTOR_METADATA_HEADERS),
].join(",");

export const SMOKE_ROUTES = {
  pairingHandshake: bridge.routes.extension.pairingHandshake,
  pairingConfirm: bridge.routes.extension.pairingConfirm,
  connectorHandshake: bridge.routes.connector.connectorHandshake,
  poll: bridge.routes.connector.poll,
  result: bridge.routes.connector.result,
} as const;

export const BRIDGE_ALLOWED_METHODS = [
  ...new Set(
    Object.values(bridge.routes).flatMap((routes) =>
      Object.values(routes).map((route) => route.method),
    ),
  ),
].join(",");

export type SmokeRouteName = keyof typeof SMOKE_ROUTES;
export type ConnectorRequestRouteName = "poll" | "result";
export type AuthenticationDomain = keyof typeof HMAC_AUTHENTICATION.domains;

export type BridgeRequestChallenge = {
  readonly bridgeEpoch: string;
  readonly requestNonce: string;
};

export type ConnectorProofIdentity = {
  readonly connectorId: string;
  readonly extensionId: string;
  readonly extensionDisplayVersion: string;
  readonly protocolFingerprint: string;
};

const canonical = (parts: ReadonlyArray<string>): string => JSON.stringify(parts);

const serverProofMessage = (
  domain: AuthenticationDomain,
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

const requestProofMessage = (
  domain: AuthenticationDomain,
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

const connectorProofIdentity = (
  identity: ConnectorProofIdentity,
  pairingId?: string,
): ReadonlyArray<string> => [
  identity.connectorId,
  identity.extensionId,
  identity.extensionDisplayVersion,
  identity.protocolFingerprint,
  pairingId ?? "",
];

export const connectorServerProofMessage = (
  domain: "connectorServerProof" | "pairingServerProof",
  identity: ConnectorProofIdentity,
  clientNonce: string,
  challenge: BridgeRequestChallenge,
  serverProtocolFingerprint: string,
  pairingId?: string,
): string =>
  serverProofMessage(
    domain,
    connectorProofIdentity(identity, pairingId),
    clientNonce,
    challenge,
    serverProtocolFingerprint,
  );

export const connectorRequestProofMessage = (
  domain: "connectorRequestProof" | "pairingRequestProof",
  identity: ConnectorProofIdentity,
  challenge: BridgeRequestChallenge,
  method: string,
  path: string,
  bodyHash: string,
  pairingId?: string,
): string =>
  requestProofMessage(
    domain,
    connectorProofIdentity(identity, pairingId),
    challenge,
    identity.protocolFingerprint,
    method,
    path,
    bodyHash,
  );

export const freshAuthenticationToken = (): string => randomBytes(32).toString("hex");

export const hashBridgeRequestBody = (body: string): string =>
  createHash(HMAC_AUTHENTICATION.digest)
    .update(body, "utf8")
    .digest(HMAC_AUTHENTICATION.proofEncoding as BinaryToTextEncoding);

export const hmacProof = (secret: string, message: string): string =>
  createHmac(
    HMAC_AUTHENTICATION.digest,
    Buffer.from(secret, HMAC_AUTHENTICATION.keyEncoding as BufferEncoding),
  )
    .update(message)
    .digest(HMAC_AUTHENTICATION.proofEncoding as BinaryToTextEncoding);

export const proofMatches = (secret: string, message: string, proof: string): boolean => {
  if (!/^[0-9a-f]{64}$/i.test(proof)) return false;
  const expected = hmacProof(secret, message);
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(expected, "hex"));
};

export const extensionIdFromManifestKey = (key: string): string => {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  return [...digest].map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 0x0f]}`).join("");
};

export const matchesRoute = (
  name: SmokeRouteName,
  method: string | undefined,
  path: string,
): boolean => {
  const route = SMOKE_ROUTES[name];
  return method === route.method && path === route.path;
};

const asObject = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SmokeFailure(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
};

const stringField = (
  value: Readonly<Record<string, unknown>>,
  field: string,
  label: string,
): string => {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new SmokeFailure(`${label}.${field} must be a non-empty string`);
  }
  return fieldValue;
};

export const decodeProfileConnector = (value: unknown): ProfileConnector => {
  const connector = asObject(value, "profile connector");
  return {
    connectorId: stringField(connector, "connectorId", "profile connector"),
    secret: stringField(connector, "secret", "profile connector"),
    label: stringField(connector, "label", "profile connector"),
    extensionId: stringField(connector, "extensionId", "profile connector"),
    extensionDisplayVersion: stringField(connector, "extensionDisplayVersion", "profile connector"),
    protocolFingerprint: stringField(connector, "protocolFingerprint", "profile connector"),
  };
};

export const decodePairingConnector = (text: string): ProfileConnector => {
  const body = asObject(JSON.parse(text) as unknown, "pairing confirmation");
  return decodeProfileConnector(body.connector);
};

export const decodeHandshake = (text: string): BridgeAuthenticationHandshake => {
  const handshake = asObject(JSON.parse(text) as unknown, "authentication handshake");
  return {
    bridgeDisplayVersion: stringField(
      handshake,
      "bridgeDisplayVersion",
      "authentication handshake",
    ),
    protocolFingerprint: stringField(handshake, "protocolFingerprint", "authentication handshake"),
    bridgeEpoch: stringField(handshake, "bridgeEpoch", "authentication handshake"),
    requestNonce: stringField(handshake, "requestNonce", "authentication handshake"),
    proof: stringField(handshake, "proof", "authentication handshake"),
  };
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
};

export const decodeWireResult = (text: string): WireResult => {
  const result = asObject(JSON.parse(text) as unknown, "wire result");
  const id = stringField(result, "id", "wire result");
  if (typeof result.ok !== "boolean") throw new SmokeFailure("wire result.ok must be boolean");
  if (result.ok) {
    if (!("value" in result) || !isJsonValue(result.value)) {
      throw new SmokeFailure("successful wire result.value is not JSON");
    }
    return { id, ok: true, value: result.value };
  }
  const error = asObject(result.error, "wire result.error");
  const tag = stringField(error, "_tag", "wire result.error");
  if (tag === "CommandRejected") {
    return {
      id,
      ok: false,
      error: {
        _tag: tag,
        code: stringField(error, "code", "wire result.error"),
        message: stringField(error, "message", "wire result.error"),
      },
    };
  }
  if (tag === "CommandOutcomeUnknown") {
    return {
      id,
      ok: false,
      error: {
        _tag: tag,
        message: stringField(error, "message", "wire result.error"),
        cause: stringField(error, "cause", "wire result.error"),
      },
    };
  }
  throw new SmokeFailure(`wire result.error._tag is unsupported: ${tag}`);
};
