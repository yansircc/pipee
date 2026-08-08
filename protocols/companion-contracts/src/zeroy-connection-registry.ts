import { Schema } from "effect";

/**
 * zeroY connection registry contract.
 *
 * Ownership split:
 * - The WordPress plugin owns site identity and the irreversible grant hash.
 * - The Pipee instance owns the persistent connection directory and the
 *   client grant secret (stored in protected secret storage by credentialRef).
 * - The zeroY extension consumes a read-only connection projection; it never
 *   owns a second editable connection file.
 */

export const ZEROY_CONNECTION_REGISTRY_CAPABILITY = "pipee/zeroy-connection-registry@1" as const;

export const ZEROY_AUTHORIZATION_INTENT_CONTRACT = "zeroy/connection-authorization-intent@1" as const;
export const ZEROY_GRANT_CONTRACT = "zeroy/connection-grant@1" as const;
export const ZEROY_CONNECTION_DIRECTORY_CONTRACT = "pipee/zeroy-connection-directory@1" as const;

/** One-way public hash of a grant secret, as stored by the WordPress plugin. */
export const GrantHash = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("GrantHash"),
);
export type GrantHash = typeof GrantHash.Type;

/** Opaque reference into Pipee protected secret storage. Never grant plaintext. */
export const CredentialRef = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)),
  Schema.brand("CredentialRef"),
);
export type CredentialRef = typeof CredentialRef.Type;

export const ZeroYSiteId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)),
  Schema.brand("ZeroYSiteId"),
);
export type ZeroYSiteId = typeof ZeroYSiteId.Type;

/** Non-sensitive connection metadata persisted in the Pipee connection directory. */
export const StoredZeroYSite = Schema.Struct({
  siteId: ZeroYSiteId,
  label: Schema.NonEmptyString,
  endpoint: Schema.String.pipe(Schema.check(Schema.isPattern(/^https?:\/\/[^/]+\/?$/))),
  grantId: Schema.NonEmptyString,
  credentialRef: CredentialRef,
  createdAt: Schema.String, // ISO 8601
  lastUsedAt: Schema.NullOr(Schema.String), // ISO 8601
  revokedAt: Schema.NullOr(Schema.String), // ISO 8601
});
export type StoredZeroYSite = typeof StoredZeroYSite.Type;

/** Read-only projection handed to the zeroY extension. Never includes secrets. */
export const ZeroYSiteConnectionProjection = Schema.Struct({
  siteId: ZeroYSiteId,
  label: Schema.NonEmptyString,
  endpoint: Schema.String,
  grantId: Schema.NonEmptyString,
  credentialRef: Schema.NonEmptyString,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
});
export type ZeroYSiteConnectionProjection = typeof ZeroYSiteConnectionProjection.Type;

export const ZeroYSiteConnectionProjectionList = Schema.Struct({
  contract: Schema.Literal(ZEROY_CONNECTION_DIRECTORY_CONTRACT),
  observedAt: Schema.String,
  sites: Schema.Array(ZeroYSiteConnectionProjection),
});
export type ZeroYSiteConnectionProjectionList = typeof ZeroYSiteConnectionProjectionList.Type;

/**
 * WordPress -> Pipee authorization intent exchange.
 * The intent is short-lived, single-use, and bound to site identity, the
 * Pipee instance (client_id), the redirect URI, and a PKCE challenge.
 */
export const ConnectionAuthorizationIntent = Schema.Struct({
  contract: Schema.Literal(ZEROY_AUTHORIZATION_INTENT_CONTRACT),
  intentId: Schema.NonEmptyString,
  siteId: ZeroYSiteId,
  clientId: Schema.NonEmptyString, // e.g. "pipee-local"
  redirectUri: Schema.String, // Pipee callback URL
  codeChallenge: Schema.NonEmptyString, // PKCE S256
  state: Schema.NonEmptyString, // CSRF binding between Pipee intent and callback
  createdAt: Schema.String,
  expiresAt: Schema.String,
  consumedAt: Schema.NullOr(Schema.String),
});
export type ConnectionAuthorizationIntent = typeof ConnectionAuthorizationIntent.Type;

/** One Pipee instance grant bound to a site. WordPress stores only the hash. */
export const ClientGrant = Schema.Struct({
  contract: Schema.Literal(ZEROY_GRANT_CONTRACT),
  grantId: Schema.NonEmptyString,
  grantHash: GrantHash,
  siteId: ZeroYSiteId,
  clientId: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});
export type ClientGrant = typeof ClientGrant.Type;

/** Pipee-side pending pairing record before the code exchange completes. */
export const PendingPairingIntent = Schema.Struct({
  intentId: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  codeVerifier: Schema.NonEmptyString,
  codeChallenge: Schema.NonEmptyString,
  redirectUri: Schema.String,
  clientId: Schema.NonEmptyString,
  endpoint: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type PendingPairingIntent = typeof PendingPairingIntent.Type;

/**
 * Host capability port surface. The extension receives a read-only projection
 * of connections and performs pairing actions; the host owns persistence and
 * secret storage. Implemented by the Pipee host; consumed via extension-kit.
 * Pairing actions are asynchronous because the host performs WordPress REST
 * calls (intent creation, code exchange, grant revocation) before returning.
 */
export interface ZeroYConnectionRegistryPort {
  /** Read the current read-only projection for this extension. */
  readonly list: () => ZeroYSiteConnectionProjectionList;
  /**
   * Create a WordPress authorization intent and return the browser URL the
   * administrator opens to approve the Pipee connection.
   */
  readonly beginPairing: (input: {
    readonly endpoint: string;
    readonly label: string;
  }) => Promise<{ readonly authorizationUrl: string; readonly intentId: string }>;
  /**
   * Exchange a short-lived pairing code (code_verifier) created in WordPress
   * for a client grant, without a Pipee-held pending intent.
   */
  readonly pairWithCode: (input: {
    readonly endpoint: string;
    readonly intentId: string;
    readonly code: string;
    readonly state: string;
    readonly redirectUri: string;
    readonly label: string;
  }) => Promise<{ readonly siteId: string; readonly grantId: string }>;
  /** Exchange an authorization code from the WordPress callback. */
  readonly exchangeCode: (input: {
    readonly intentId: string;
    readonly code: string;
    readonly state: string;
  }) => Promise<{ readonly siteId: string; readonly grantId: string }>;
  /** Revoke a connection: delete local secret and request WordPress revocation. */
  readonly revoke: (siteId: string) => Promise<void>;
  /** Read a grant secret for an outbound Connector request. Never logged. */
  readonly readSecret: (credentialRef: string) => string;
  /** Subscribe to connection directory changes (fires on any mutation). */
  readonly subscribe: (listener: () => void) => () => void;
}
