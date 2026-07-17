import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { BinaryToTextEncoding } from "node:crypto";
import {
  requestProofMessage,
  serverProofMessage,
  type BridgeRequestChallenge,
} from "../protocol/bridge-authentication.js";
import {
  AUTHENTICATION_CHALLENGE_DEADLINE_MS,
  HMAC_AUTHENTICATION,
  PENDING_CHALLENGE_LIMIT,
} from "../protocol/bridge-contract.js";
import type { BridgeOwnerIdentity } from "../protocol/bridge-owner.js";
import { isHex256 } from "../protocol/hex-256.js";

export const nodeHmacProof = (credential: string, message: string): string =>
  createHmac(
    HMAC_AUTHENTICATION.digest,
    Buffer.from(credential, HMAC_AUTHENTICATION.keyEncoding as BufferEncoding),
  )
    .update(message)
    .digest(HMAC_AUTHENTICATION.proofEncoding as BinaryToTextEncoding);

const proofMatches = (actual: string, expected: string): boolean =>
  isHex256(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

export const freshAuthenticationToken = (): string => randomBytes(32).toString("hex");

export const hashBridgeRequestBody = (body: string): string =>
  createHash(HMAC_AUTHENTICATION.digest)
    .update(body, "utf8")
    .digest(HMAC_AUTHENTICATION.proofEncoding as BinaryToTextEncoding);

export const hasValidNodeHmacProof = (
  credential: string,
  message: string,
  proof: string,
): boolean => proofMatches(proof, nodeHmacProof(credential, message));

export const ownerServerProof = (
  identity: BridgeOwnerIdentity,
  clientNonce: string,
  challenge: BridgeRequestChallenge,
): string =>
  nodeHmacProof(
    identity.credential,
    serverProofMessage(
      "ownerServerProof",
      [],
      clientNonce,
      challenge,
      identity.protocolFingerprint,
    ),
  );

export const hasValidOwnerServerProof = (
  identity: BridgeOwnerIdentity,
  clientNonce: string,
  challenge: BridgeRequestChallenge,
  proof: string,
): boolean => proofMatches(proof, ownerServerProof(identity, clientNonce, challenge));

export type OwnerRequestProofInput = BridgeRequestChallenge & {
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
};

export const ownerRequestProof = (
  identity: BridgeOwnerIdentity,
  input: OwnerRequestProofInput,
): string =>
  nodeHmacProof(
    identity.credential,
    requestProofMessage(
      "ownerRequestProof",
      [],
      input,
      identity.protocolFingerprint,
      input.method,
      input.path,
      input.bodyHash,
    ),
  );

export const hasValidOwnerRequestProof = (
  identity: BridgeOwnerIdentity,
  input: OwnerRequestProofInput,
  proof: string,
): boolean => proofMatches(proof, ownerRequestProof(identity, input));

export type BridgeChallengeScope = "owner" | "connector";

const BRIDGE_CHALLENGE_SCOPES = [
  "owner",
  "connector",
] as const satisfies ReadonlyArray<BridgeChallengeScope>;

export type BridgeRequestProofHeaders = BridgeRequestChallenge & {
  readonly bodyHash: string;
  readonly proof: string;
};

export type BridgeChallengeAdmission =
  | { readonly _tag: "Accepted"; readonly authentication: BridgeRequestProofHeaders }
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Unavailable" };

export class BridgeChallengeRegistry {
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly generateToken: () => string = freshAuthenticationToken,
  ) {}

  issue(now: number): string {
    this.prune(now);
    while (this.pending.size >= this.limit) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    let requestNonce = this.generateToken();
    while (this.pending.has(requestNonce)) requestNonce = this.generateToken();
    this.pending.set(requestNonce, now + this.ttlMs);
    return requestNonce;
  }

  consume(requestNonce: string, now: number): boolean {
    this.prune(now);
    if (!this.pending.has(requestNonce)) return false;
    this.pending.delete(requestNonce);
    return true;
  }

  pruneAndCount(now: number): number {
    this.prune(now);
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }

  private prune(now: number): void {
    for (const [requestNonce, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(requestNonce);
    }
  }
}

export class BridgeAuthenticationSession {
  readonly bridgeEpoch = freshAuthenticationToken();
  private readonly challenges = Object.fromEntries(
    BRIDGE_CHALLENGE_SCOPES.map((scope) => [
      scope,
      new BridgeChallengeRegistry(PENDING_CHALLENGE_LIMIT, AUTHENTICATION_CHALLENGE_DEADLINE_MS),
    ]),
  ) as Record<BridgeChallengeScope, BridgeChallengeRegistry>;

  issue(scope: BridgeChallengeScope, now: number): BridgeRequestChallenge {
    return {
      bridgeEpoch: this.bridgeEpoch,
      requestNonce: this.challenges[scope].issue(now),
    };
  }

  authorize(
    scope: BridgeChallengeScope,
    authentication: BridgeRequestProofHeaders,
    now: number,
  ): BridgeChallengeAdmission {
    if (
      authentication.bridgeEpoch !== this.bridgeEpoch ||
      !isHex256(authentication.requestNonce) ||
      !isHex256(authentication.bodyHash)
    ) {
      return { _tag: "Malformed" };
    }
    return this.challenges[scope].consume(authentication.requestNonce, now)
      ? { _tag: "Accepted", authentication }
      : { _tag: "Unavailable" };
  }

  revoke(scope: BridgeChallengeScope, requestNonce: string, now: number): void {
    this.challenges[scope].consume(requestNonce, now);
  }
}
