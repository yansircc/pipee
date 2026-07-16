import auth from "./connector-auth.json" with { type: "json" };

export const EXTENSION_PUBLIC_KEY = auth.extensionPublicKey;

export const CONNECTOR_ID_HEADER = auth.headers.id;
export const CONNECTOR_EXTENSION_ID_HEADER = auth.headers.extensionId;
export const CONNECTOR_CLIENT_NONCE_HEADER = auth.headers.clientNonce;
export const CONNECTOR_BRIDGE_EPOCH_HEADER = auth.headers.bridgeEpoch;
export const CONNECTOR_REQUEST_NONCE_HEADER = auth.headers.requestNonce;
export const CONNECTOR_BODY_SHA256_HEADER = auth.headers.bodySha256;
export const CONNECTOR_PROOF_HEADER = auth.headers.proof;
export const CONNECTOR_DISPLAY_VERSION_METADATA_HEADER = auth.metadataHeaders.displayVersion;
export const CONNECTOR_PROTOCOL_FINGERPRINT_HEADER = auth.metadataHeaders.protocolFingerprint;
export const PAIRING_ID_HEADER = auth.headers.pairingId;

export const CONNECTOR_REQUEST_HEADERS = [
  "content-type",
  CONNECTOR_ID_HEADER,
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_CLIENT_NONCE_HEADER,
  CONNECTOR_BRIDGE_EPOCH_HEADER,
  CONNECTOR_REQUEST_NONCE_HEADER,
  CONNECTOR_BODY_SHA256_HEADER,
  CONNECTOR_PROOF_HEADER,
  CONNECTOR_DISPLAY_VERSION_METADATA_HEADER,
  CONNECTOR_PROTOCOL_FINGERPRINT_HEADER,
  PAIRING_ID_HEADER,
].join(",");

export const CONNECTOR_STORAGE_KEY = auth.storageKey;
