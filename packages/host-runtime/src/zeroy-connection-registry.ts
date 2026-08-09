import {
  ZEROY_CONNECTION_REGISTRY_CAPABILITY,
  type ZeroYConnectionRegistryPort,
  type ZeroYSiteConnectionProjectionList,
} from "@pipee/companion-contracts/zeroy-connection-registry";
import { createHash, randomUUID } from "node:crypto";
import { Data, Effect, FileSystem, Path, Schema, Semaphore } from "effect";

/**
 * Pipee-owned zeroY connection registry.
 *
 * Facts owned here:
 * - The connection directory (non-sensitive metadata: siteId, label,
 *   endpoint, grantId, credentialRef, timestamps, revocation state).
 * - Grant secrets (credentialRef -> grant plaintext) in protected storage.
 *   Never returned to UI, logs, or the extension projection.
 * - Pairing orchestration: the short-lived pending intent map, WordPress
 *   intent creation (beginPairing), code exchange (exchangeCode /
 *   pairWithCode), and grant revocation. One state machine backs both the
 *   Pipee HTTP service and the extension capability port, so a pairing
 *   started from either surface can be completed by the other.
 *
 * The WordPress plugin owns site identity, grant hashes, and the irreversible
 * grant hash store. Persistence is explicit: the host injects a persist
 * callback (closed over the protected directory) that runs after every
 * orchestration mutation.
 *
 * load/persist take an explicit directory so the host decides where the
 * protected directory lives (defaults to ~/.pipee/zeroy when omitted).
 */

export class ZeroYConnectionRegistryError extends Data.TaggedError("ZeroYConnectionRegistryError")<{
  readonly operation: string;
  readonly message: string;
  /** Non-sensitive WordPress grant id, when the failure involves a specific grant. */
  readonly grantId?: string;
}> {}

/**
 * One immutable registry snapshot: metadata rows and grant secrets in a
 * single versioned unit. Persistence writes exactly this snapshot (one file,
 * one generation), so a partially written disk state can never mix rows from
 * one generation with secrets from another.
 */
export type ZeroYRegistrySnapshot = {
  readonly version: 1;
  readonly generation: number;
  readonly rows: ReadonlyArray<StoredZeroYSiteRow>;
  readonly secrets: Readonly<Record<string, string>>;
};

export interface ZeroYConnectionRegistryCallbacks {
  /** Persists one immutable snapshot. A persistence failure must surface: a
   * connection that reports success must survive a restart. */
  readonly persist?: (snapshot: ZeroYRegistrySnapshot) => Effect.Effect<void, unknown>;
  /** Pipee callback origin (defaults to the local dev callback). Injected so
   * the shared registry never hard-codes a host address. */
  readonly redirectUri?: string;
}

export type StoredZeroYSiteRow = {
  readonly siteId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly grantId: string;
  readonly credentialRef: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
};

export type ZeroYPairingIntent = {
  readonly authorizationUrl: string;
  readonly intentId: string;
};

/** Pending pairing state held by the registry until the callback returns. */
export type ZeroYPendingPairing = {
  readonly intentId: string;
  readonly endpoint: string;
  readonly label: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
};

export type ZeroYPairWithCodeInput = {
  readonly endpoint: string;
  readonly intentId: string;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly label: string;
};

export type ZeroYExchangeResult = {
  readonly siteId: string;
  readonly grantId: string;
};

const RegistryRowSchema = Schema.Struct({
  siteId: Schema.String,
  label: Schema.String,
  endpoint: Schema.String,
  grantId: Schema.String,
  credentialRef: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
});

const RegistryStateSchema = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.Int,
  rows: Schema.Array(RegistryRowSchema),
  secrets: Schema.Record(Schema.String, Schema.String),
});

const normalizeEndpoint = (endpoint: string): string => {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!URL.canParse(trimmed) || !/^https?:\/\//.test(trimmed)) {
    throw new ZeroYConnectionRegistryError({
      operation: "normalize-endpoint",
      message: `Invalid zeroY endpoint: ${trimmed}`,
    });
  }
  return trimmed;
};

export type ZeroYConnectionRegistryHandle = {
  readonly provider: { readonly forExtension: (ownerId: string) => ZeroYConnectionRegistryPort };
  readonly load: (
    directory: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
  readonly persist: (
    directory: string,
    snapshot: ZeroYRegistrySnapshot,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;
  readonly upsert: (
    row: Omit<StoredZeroYSiteRow, "createdAt" | "lastUsedAt" | "revokedAt" | "credentialRef">,
    grantSecret: string,
  ) => void;
  readonly markUsed: (siteId: string) => void;
  readonly markRevoked: (siteId: string) => void;
  readonly rows: () => ReadonlyArray<StoredZeroYSiteRow>;
  /** Create a WordPress intent and return the administrator browser URL. */
  readonly beginPairing: (
    endpoint: string,
    label: string,
  ) => Effect.Effect<ZeroYPairingIntent, ZeroYConnectionRegistryError>;
  /** Complete a Pipee-initiated pairing from the browser callback. */
  readonly exchangeCode: (
    intentId: string,
    code: string,
    state: string,
  ) => Effect.Effect<ZeroYExchangeResult, ZeroYConnectionRegistryError>;
  /** Complete a WordPress-initiated pairing with a short-lived pairing code. */
  readonly pairWithCode: (
    input: ZeroYPairWithCodeInput,
  ) => Effect.Effect<ZeroYExchangeResult, ZeroYConnectionRegistryError>;
  /** Revoke a grant on WordPress (best effort) and locally. */
  readonly revokeOnWordPress: (siteId: string) => Effect.Effect<void, ZeroYConnectionRegistryError>;
  readonly dispose: () => void;
};

const toProjectionSite = (site: StoredZeroYSiteRow) => ({
  siteId: site.siteId,
  label: site.label,
  endpoint: site.endpoint,
  grantId: site.grantId,
  credentialRef: site.credentialRef,
  createdAt: site.createdAt,
  lastUsedAt: site.lastUsedAt,
  revoked: site.revokedAt !== null,
});

export const makeZeroYConnectionRegistry = (
  callbacks: ZeroYConnectionRegistryCallbacks = {},
): ZeroYConnectionRegistryHandle => {
  let rows: ReadonlyArray<StoredZeroYSiteRow> = [];
  let generation = 0;
  let disposed = false;
  const listeners = new Set<() => void>();
  const pending = new Map<string, ZeroYPendingPairing>();
  // The registry owns the runtime secret projection as one immutable map,
  // replaced atomically with each committed snapshot. readSecret therefore
  // reflects exactly what was persisted: a reported success is always
  // usable in this process.
  let secrets: Readonly<Record<string, string>> = {};

  const currentSecrets = (): Readonly<Record<string, string>> => secrets;

  const snapshotOf = (nextRows: ReadonlyArray<StoredZeroYSiteRow>, nextSecrets: Readonly<Record<string, string>>): ZeroYRegistrySnapshot => ({
    version: 1,
    generation: generation + 1,
    rows: nextRows,
    secrets: nextSecrets,
  });

  /**
   * Disk persistence of one snapshot. This is the ONLY phase the pairing
   * compensation is bound to: a failure here means the just-created
   * WordPress grant has no durable local counterpart.
   */
  const persistSnapshot = (
    snapshot: ZeroYRegistrySnapshot,
  ): Effect.Effect<void, ZeroYConnectionRegistryError> =>
    callbacks.persist === undefined
      ? Effect.void
      : callbacks.persist(snapshot).pipe(
          Effect.mapError(
            (cause) =>
              new ZeroYConnectionRegistryError({
                operation: "persist",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );

  /**
   * Commit a persisted snapshot to the public in-memory state and notify
   * listeners. This is pure immutable reference replacement (rows, secrets,
   * generation) and cannot fail, so a persisted pairing is always usable in
   * this process: readSecret(newCredentialRef) reflects the snapshot.
   * Subscriber exceptions are isolated so they never turn a successful
   * mutation into a failure.
   */
  const commitAndNotify = (snapshot: ZeroYRegistrySnapshot): Effect.Effect<void, never> =>
    Effect.sync(() => {
      rows = snapshot.rows;
      generation = snapshot.generation;
      secrets = snapshot.secrets;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (cause) {
          console.error("[zeroy] connection listener failed", cause);
        }
      }
    });

  /** Persist one snapshot, then commit memory. Never compensates. */
  const persistAndCommit = (snapshot: ZeroYRegistrySnapshot): Effect.Effect<void, ZeroYConnectionRegistryError> =>
    persistSnapshot(snapshot).pipe(Effect.tap(() => commitAndNotify(snapshot)));

  /**
   * Persist a pairing snapshot with compensation for the WordPress grant that
   * the exchange already created. A failed local write must not leave a grant
   * on WordPress that Pipee can no longer manage: we revoke it with the grant
   * secret we hold. The error is bounded (operation + message + grantId) and
   * explicitly marks a possibly-orphaned grant when the compensating revoke
   * also fails. The grant secret never leaves this process.
   */
  /**
   * Persist a pairing snapshot with compensation for the WordPress grant the
   * exchange already created. Compensation is bound ONLY to an explicit disk
   * persist failure: once the snapshot is on disk, commit + notify are
   * infallible and never revoke the persisted grant.
   */
  const persistPairingWithCompensation = (
    endpoint: string,
    grantId: string,
    grantSecret: string,
    snapshot: ZeroYRegistrySnapshot,
  ): Effect.Effect<void, ZeroYConnectionRegistryError> =>
    persistSnapshot(snapshot).pipe(
      Effect.catch((error) =>
        revokeWordPressGrant(endpoint, grantId, grantSecret).pipe(
          Effect.flatMap((revoked) =>
            Effect.fail(
              new ZeroYConnectionRegistryError({
                operation: error.operation,
                message: revoked
                  ? `${error.message} The new WordPress grant ${grantId} was revoked as compensation; re-pair to connect.`
                  : `${error.message} The compensating revocation of WordPress grant ${grantId} also failed; the grant may be orphaned and must be revoked in the WordPress admin.`,
                grantId,
              }),
            ),
          ),
        ),
      ),
      Effect.tap(() => commitAndNotify(snapshot)),
    );

  // Pairing and revocation mutate the same per-site rows (supersede revoke
  // then upsert). Concurrent pairings for one site must not interleave or
  // both revoke the previous grant and write different grants.
  const siteLocks = new Map<string, Semaphore.Semaphore>();
  const withSiteLock = <A, E>(siteId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
    const lock = siteLocks.get(siteId) ?? Semaphore.makeUnsafe(1);
    siteLocks.set(siteId, lock);
    return lock.withPermits(1)(effect);
  };

  const notify = (): void => {
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  /**
   * Best-effort revocation of a grant on WordPress using its own secret. The
   * WordPress plugin stores only the irreversible grant hash, so the Bearer
   * secret is the only way a grant holder can revoke itself.
   */
  const revokeWordPressGrant = (
    endpoint: string,
    grantId: string,
    secret: string,
  ): Effect.Effect<boolean, never> =>
    Effect.tryPromise(async () => {
      try {
        const response = await fetch(
          `${normalizeEndpoint(endpoint)}/wp-json/zeroy/v1/connection/grants/${grantId}`,
          { method: "DELETE", headers: { authorization: `Bearer ${secret}` } },
        );
        return response.ok;
      } catch {
        return false;
      }
    }).pipe(Effect.catch(() => Effect.succeed(false)));

  /**
   * Revoke the previous active grant for the same site before a new grant
   * supersedes it, so WordPress does not accumulate orphan grants. The new
   * pairing always succeeds; a failed revocation only leaves the old grant
   * unusable (its secret is deleted locally) and revocable from the admin.
   */
  /**
   * Find the previous active grant for the same site that a new grant
   * supersedes. The revocation happens AFTER the new state is persisted and
   * committed (best effort): a failed write must not have already revoked
   * anything, and the old local secret is dropped once the new state is
   * durable — a grant without its secret is unusable, which is equivalent to
   * revocation, and keeping the plaintext secret on disk would widen the
   * leak surface.
   */
  const findSuperseded = (
    siteId: string,
    keepGrantId: string,
  ): { readonly row: StoredZeroYSiteRow; readonly secret: string } | null => {
    const existing = rows.find(
      (site) => site.siteId === siteId && site.revokedAt === null && site.grantId !== keepGrantId,
    );
    if (existing === undefined) return null;
    const secret = secrets[existing.credentialRef];
    return secret === undefined ? null : { row: existing, secret };
  };

  const beginPairing = (
    endpoint: string,
    label: string,
  ): Effect.Effect<ZeroYPairingIntent, ZeroYConnectionRegistryError> =>
    Effect.gen(function* () {
      const target = normalizeEndpoint(endpoint);
      const state = randomUUID();
      const codeVerifier = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
      // PKCE S256: the challenge is the hex digest of the verifier. The
      // WordPress plugin stores the challenge and compares it against
      // hash(sha256, verifier) at exchange time.
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("hex");
      const redirectUri =
        callbacks.redirectUri ?? "http://127.0.0.1:30141/zeroy/connect/callback";
      const intentId = randomUUID();
      pending.set(intentId, {
        intentId,
        endpoint: target,
        label,
        state,
        codeVerifier,
        redirectUri,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const authorizeUrl = new URL(`${target}/wp-json/zeroy/v1/connection/authorize`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(authorizeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              intent_id: intentId,
              client_id: "pipee-local",
              redirect_uri: redirectUri,
              code_challenge: codeChallenge,
              state,
              label,
            }),
          }),
        catch: (cause) =>
          new ZeroYConnectionRegistryError({
            operation: "begin-pairing",
            message: `Could not reach ${target}: ${String(cause)}`,
          }),
      });
      if (!response.ok) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "begin-pairing",
          message: `WordPress rejected the authorization intent (${response.status}).`,
        });
      }
      const created = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "begin-pairing",
            message: "Invalid authorize response",
          }),
      });
      if (typeof created.intentId !== "string" || created.intentId === "") {
        return yield* new ZeroYConnectionRegistryError({
          operation: "begin-pairing",
          message: "WordPress did not return an authorization intent.",
        });
      }
      // WordPress owns the intent identity. Re-key the pending pairing under
      // the WordPress intent id so the callback can look it up by the exact
      // value the browser URL carries.
      const pairing = pending.get(intentId);
      pending.delete(intentId);
      if (pairing !== undefined) pending.set(created.intentId, { ...pairing, intentId: created.intentId });
      const authorizationUrl =
        `${target}/wp-admin/admin.php?page=zeroy-connections` +
        `&intent_id=${encodeURIComponent(created.intentId)}` +
        `&client_id=${encodeURIComponent("pipee-local")}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code_challenge=${encodeURIComponent(codeChallenge)}` +
        `&state=${encodeURIComponent(state)}`;
      return { authorizationUrl, intentId: created.intentId };
    });

  const exchangeCode = (
    intentId: string,
    code: string,
    state: string,
  ): Effect.Effect<ZeroYExchangeResult, ZeroYConnectionRegistryError> =>
    Effect.gen(function* () {
      const pairing = pending.get(intentId);
      if (pairing === undefined) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: "Pairing intent is missing or already consumed.",
        });
      }
      if (pairing.expiresAt < Date.now()) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: "Pairing intent has expired.",
        });
      }
      if (pairing.state !== state) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: "Pairing state does not match.",
        });
      }
      const exchangeUrl = new URL(`${pairing.endpoint}/wp-json/zeroy/v1/connection/exchange`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(exchangeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              intent_id: intentId,
              code,
              code_verifier: pairing.codeVerifier,
              state,
              redirect_uri: pairing.redirectUri,
            }),
          }),
        catch: (cause) =>
          new ZeroYConnectionRegistryError({
            operation: "exchange-code",
            message: `Exchange request failed: ${String(cause)}`,
          }),
      });
      if (!response.ok) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: `WordPress rejected the code exchange (${response.status}).`,
        });
      }
      const grant = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "exchange-code",
            message: "Invalid exchange response",
          }),
      });
      if (typeof grant.grantId !== "string" || typeof grant.siteId !== "string") {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: "WordPress returned an invalid grant.",
        });
      }
      if (typeof grant.grantSecret !== "string" || grant.grantSecret === "") {
        return yield* new ZeroYConnectionRegistryError({
          operation: "exchange-code",
          message: "WordPress returned no grant secret.",
        });
      }
      const siteId: string = grant.siteId;
      const grantId: string = grant.grantId;
      const grantSecret: string = grant.grantSecret;
      // The critical section is per-site: derive next state, persist the
      // snapshot, commit memory, then revoke the superseded grant remotely.
      // Ordering matters: a failed persist leaves public state untouched and
      // never revokes anything.
      return yield* withSiteLock(
        siteId,
        Effect.gen(function* () {
          const superseded = findSuperseded(siteId, grantId);
          const credentialRef = `zeroy-grant-${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const row: StoredZeroYSiteRow = {
            siteId,
            label: pairing.label,
            endpoint: pairing.endpoint,
            grantId,
            credentialRef,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
          };
          const nextSecrets: Record<string, string> = { ...currentSecrets(), [credentialRef]: grantSecret };
          if (superseded !== null) delete nextSecrets[superseded.row.credentialRef];
          // One row per site: a revoked previous row is replaced too, never
          // appended alongside the fresh row.
          const hasSiteRow = rows.some((site) => site.siteId === siteId);
          const nextRows = hasSiteRow
            ? rows.map((site) => (site.siteId === siteId ? row : site))
            : [...rows, row];
          const snapshot = snapshotOf(nextRows, nextSecrets);
          yield* persistPairingWithCompensation(pairing.endpoint, grantId, grantSecret, snapshot);
          pending.delete(intentId);
          if (superseded !== null) {
            yield* revokeWordPressGrant(superseded.row.endpoint, superseded.row.grantId, superseded.secret);
          }
          return { siteId, grantId };
        }),
      );
    });

  const pairWithCode = (
    input: ZeroYPairWithCodeInput,
  ): Effect.Effect<ZeroYExchangeResult, ZeroYConnectionRegistryError> =>
    Effect.gen(function* () {
      const target = normalizeEndpoint(input.endpoint);
      const exchangeUrl = new URL(`${target}/wp-json/zeroy/v1/connection/exchange`);
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(exchangeUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              intent_id: input.intentId,
              code: input.code,
              code_verifier: input.code,
              state: input.state,
              redirect_uri: input.redirectUri,
            }),
          }),
        catch: (cause) =>
          new ZeroYConnectionRegistryError({
            operation: "pair-with-code",
            message: `Exchange request failed: ${String(cause)}`,
          }),
      });
      if (!response.ok) {
        return yield* new ZeroYConnectionRegistryError({
          operation: "pair-with-code",
          message: `WordPress rejected the pairing code (${response.status}).`,
        });
      }
      const grant = yield* Effect.tryPromise({
        try: () => response.json() as Promise<Record<string, unknown>>,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "pair-with-code",
            message: "Invalid exchange response",
          }),
      });
      if (typeof grant.grantId !== "string" || typeof grant.siteId !== "string") {
        return yield* new ZeroYConnectionRegistryError({
          operation: "pair-with-code",
          message: "WordPress returned an invalid grant.",
        });
      }
      if (typeof grant.grantSecret !== "string" || grant.grantSecret === "") {
        return yield* new ZeroYConnectionRegistryError({
          operation: "pair-with-code",
          message: "WordPress returned no grant secret.",
        });
      }
      const siteId: string = grant.siteId;
      const grantId: string = grant.grantId;
      const grantSecret: string = grant.grantSecret;
      return yield* withSiteLock(
        siteId,
        Effect.gen(function* () {
          const superseded = findSuperseded(siteId, grantId);
          const credentialRef = `zeroy-grant-${siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const row: StoredZeroYSiteRow = {
            siteId,
            label: input.label || target,
            endpoint: target,
            grantId,
            credentialRef,
            createdAt: new Date().toISOString(),
            lastUsedAt: null,
            revokedAt: null,
          };
          const nextSecrets: Record<string, string> = { ...currentSecrets(), [credentialRef]: grantSecret };
          if (superseded !== null) delete nextSecrets[superseded.row.credentialRef];
          const hasSiteRow = rows.some((site) => site.siteId === siteId);
          const nextRows = hasSiteRow
            ? rows.map((site) => (site.siteId === siteId ? row : site))
            : [...rows, row];
          const snapshot = snapshotOf(nextRows, nextSecrets);
          yield* persistPairingWithCompensation(target, grantId, grantSecret, snapshot);
          if (superseded !== null) {
            yield* revokeWordPressGrant(superseded.row.endpoint, superseded.row.grantId, superseded.secret);
          }
          return { siteId, grantId };
        }),
      );
    });

  const revokeOnWordPress = (
    siteId: string,
  ): Effect.Effect<void, ZeroYConnectionRegistryError> =>
    withSiteLock(
      siteId,
      Effect.gen(function* () {
        const row = rows.find((site) => site.siteId === siteId && site.revokedAt === null);
        if (row === undefined) return;
        const secret = secrets[row.credentialRef];
        const nextSecrets: Record<string, string> = { ...currentSecrets() };
        if (row.credentialRef !== undefined) delete nextSecrets[row.credentialRef];
        const nextRows = rows.map((site) =>
          site.siteId === siteId && site.revokedAt === null
            ? { ...site, revokedAt: new Date().toISOString() }
            : site,
        );
        // Persist the revocation first; the remote WordPress revoke is best
        // effort after the local state is durable (a grant without its local
        // secret is unusable either way).
        yield* persistAndCommit(snapshotOf(nextRows, nextSecrets));
        if (secret !== undefined) {
          yield* revokeWordPressGrant(row.endpoint, row.grantId, secret);
        }
      }),
    );

  function upsert(
    input: Omit<StoredZeroYSiteRow, "createdAt" | "lastUsedAt" | "revokedAt" | "credentialRef">,
    grantSecret: string,
  ): void {
    const now = new Date().toISOString();
    const credentialRef = `zeroy-grant-${input.siteId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = rows.findIndex((site) => site.siteId === input.siteId);
    const row: StoredZeroYSiteRow = {
      siteId: input.siteId,
      label: input.label,
      endpoint: normalizeEndpoint(input.endpoint),
      grantId: input.grantId,
      credentialRef,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    const nextSecrets = { ...secrets };
    if (existing >= 0) {
      delete nextSecrets[rows[existing]!.credentialRef];
      rows = [...rows.slice(0, existing), row, ...rows.slice(existing + 1)];
    } else {
      rows = [...rows, row];
    }
    nextSecrets[credentialRef] = grantSecret;
    secrets = nextSecrets;
    notify();
  }

  const provider: ZeroYConnectionRegistryPort = {
    list: () =>
      ({
        contract: "pipee/zeroy-connection-directory@1",
        observedAt: new Date().toISOString(),
        sites: rows.map(toProjectionSite),
      }) as unknown as ZeroYSiteConnectionProjectionList,
    beginPairing: (input) => Effect.runPromise(beginPairing(input.endpoint, input.label)),
    pairWithCode: (input) => Effect.runPromise(pairWithCode(input)),
    exchangeCode: (input) =>
      Effect.runPromise(exchangeCode(input.intentId, input.code, input.state)),
    revoke: (siteId) => Effect.runPromise(revokeOnWordPress(siteId)),
    readSecret: (credentialRef) => {
      const secret = secrets[credentialRef];
      if (secret === undefined) {
        throw new ZeroYConnectionRegistryError({
          operation: "read-secret",
          message: "Grant secret is unavailable for this connection.",
        });
      }
      return secret;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  const load = (directory: string): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(directory, "state.json");
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      if (raw.trim() === "") return;
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "load",
            message: "Connection directory is not valid JSON; starting empty.",
          }),
      }).pipe(Effect.orElseSucceed(() => null as unknown));
      const decoded = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(RegistryStateSchema)(
            parsed,
          ) as unknown as ZeroYRegistrySnapshot,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "load",
            message: "Connection directory is corrupt; starting empty.",
          }),
      }).pipe(Effect.orElseSucceed(() => null as ZeroYRegistrySnapshot | null));
      if (decoded === null) return;
      rows = decoded.rows;
      generation = decoded.generation;
      secrets = decoded.secrets;
    });

  const persist = (
    directory: string,
    snapshot: ZeroYRegistrySnapshot,
  ): Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(directory, { recursive: true });
      const file = path.join(directory, "state.json");
      const tmp = path.join(directory, "state.json.tmp");
      // Write the temp file first and rename over the target: rename is
      // atomic, so a crash mid-write can never leave a truncated or partial
      // snapshot behind, and rows + secrets are written in one unit.
      yield* fs.writeFileString(tmp, JSON.stringify(snapshot, null, 2));
      yield* fs.rename(tmp, file);
      yield* fs.chmod(file, 0o600);
    });

  return {
    provider: { forExtension: () => provider },
    load,
    persist,
    upsert,
    markUsed: (siteId) => {
      rows = rows.map((site) =>
        site.siteId === siteId ? { ...site, lastUsedAt: new Date().toISOString() } : site,
      );
    },
    markRevoked: (siteId) => {
      rows = rows.map((site) =>
        site.siteId === siteId && site.revokedAt === null
          ? { ...site, revokedAt: new Date().toISOString() }
          : site,
      );
    },
    rows: () => rows,
    beginPairing,
    exchangeCode,
    pairWithCode,
    revokeOnWordPress,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
};

export { ZEROY_CONNECTION_REGISTRY_CAPABILITY };
