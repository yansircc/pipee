import { BRIDGE_HEADERS } from "./bridge-contract.js";

export const OWNER_PROTOCOL_FINGERPRINT_HEADER = BRIDGE_HEADERS.ownerProtocolFingerprint;
export const OWNER_CLIENT_NONCE_HEADER = BRIDGE_HEADERS.ownerClientNonce;
export const OWNER_BRIDGE_EPOCH_HEADER = BRIDGE_HEADERS.ownerBridgeEpoch;
export const OWNER_REQUEST_NONCE_HEADER = BRIDGE_HEADERS.ownerRequestNonce;
export const OWNER_BODY_SHA256_HEADER = BRIDGE_HEADERS.ownerBodySha256;
export const OWNER_PROOF_HEADER = BRIDGE_HEADERS.ownerProof;

export type BridgeOwnerIdentity = {
  readonly credential: string;
  readonly protocolFingerprint: string;
};
