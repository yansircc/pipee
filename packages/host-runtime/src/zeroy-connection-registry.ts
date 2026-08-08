import {
  ZEROY_CONNECTION_REGISTRY_CAPABILITY,
  type ZeroYConnectionRegistryPort,
  type ZeroYSiteConnectionProjectionList,
} from "@pipee/companion-contracts/zeroy-connection-registry";
import { createHash, randomUUID } from "node:crypto";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

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
}> {}

export interface SecretStorage {
  readonly read: (ref: string) => string | undefined;
  readonly write: (ref: string, secret: string) => void;
  readonly delete: (ref: string) => void;
}

export interface ZeroYConnectionRegistryCallbacks {
  readonly secretStorage?: SecretStorage;
  /** Runs after every orchestration mutation so connections persist. */
  readonly persist?: () => Effect.Effect<void, never>;
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

const RegistryStateSchema = Schema.Array(
  Schema.Struct({
    siteId: Schema.String,
    label: Schema.String,
    endpoint: Schema.String,
    grantId: Schema.String,
    credentialRef: Schema.String,
    createdAt: Schema.String,
    lastUsedAt: Schema.NullOr(Schema.String),
    revokedAt: Schema.NullOr(Schema.String),
  }),
);

export class InMemorySecretStorage implements SecretStorage {
  private readonly secrets = new Map<string, string>();
  read(ref: string): string | undefined {
    return this.secrets.get(ref);
  }
  write(ref: string, secret: string): void {
    this.secrets.set(ref, secret);
  }
  delete(ref: string): void {
    this.secrets.delete(ref);
  }
}

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
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
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
  let disposed = false;
  const listeners = new Set<() => void>();
  const pending = new Map<string, ZeroYPendingPairing>();
  const secretStorage: SecretStorage = callbacks.secretStorage ?? new InMemorySecretStorage();
  // Lazy: the host-injected persist closes over this handle, so it must only
  // run after the handle exists.
  const runPersist = (): Effect.Effect<void, never> => callbacks.persist?.() ?? Effect.void;

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
  ): Effect.Effect<void, never> =>
    Effect.tryPromise({
      try: () =>
        fetch(`${normalizeEndpoint(endpoint)}/wp-json/zeroy/v1/connection/grants/${grantId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${secret}` },
        }).then(() => undefined),
      catch: () => undefined,
    }).pipe(Effect.ignore);

  /**
   * Revoke the previous active grant for the same site before a new grant
   * supersedes it, so WordPress does not accumulate orphan grants. The new
   * pairing always succeeds; a failed revocation only leaves the old grant
   * unusable (its secret is deleted locally) and revocable from the admin.
   */
  const revokeSupersededGrant = (
    endpoint: string,
    siteId: string,
    keepGrantId: string,
  ): Effect.Effect<void, never> => {
    const existing = rows.find(
      (site) => site.siteId === siteId && site.revokedAt === null && site.grantId !== keepGrantId,
    );
    if (existing === undefined) return Effect.void;
    const secret = secretStorage.read(existing.credentialRef);
    return secret === undefined
      ? Effect.void
      : revokeWordPressGrant(endpoint, existing.grantId, secret);
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
      const redirectUri = "http://127.0.0.1:30141/zeroy/connect/callback";
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
      // Supersede any previous active grant for this site on WordPress
      // before the registry row is replaced, so no orphan grant remains.
      yield* revokeSupersededGrant(pairing.endpoint, grant.siteId, grant.grantId);
      upsert(
        {
          siteId: grant.siteId,
          label: pairing.label,
          endpoint: pairing.endpoint,
          grantId: grant.grantId,
        },
        code,
      );
      pending.delete(intentId);
      notify();
      yield* runPersist();
      return { siteId: grant.siteId, grantId: grant.grantId };
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
      // Supersede any previous active grant for this site on WordPress
      // before the registry row is replaced, so no orphan grant remains.
      yield* revokeSupersededGrant(target, grant.siteId, grant.grantId);
      upsert(
        {
          siteId: grant.siteId,
          label: input.label || target,
          endpoint: target,
          grantId: grant.grantId,
        },
        input.code,
      );
      notify();
      yield* runPersist();
      return { siteId: grant.siteId, grantId: grant.grantId };
    });

  const revokeOnWordPress = (
    siteId: string,
  ): Effect.Effect<void, ZeroYConnectionRegistryError> =>
    Effect.gen(function* () {
      // Ask WordPress to revoke the grant with its own secret (best effort)
      // before the local secret is deleted, then always complete the local
      // revocation so Pipee can no longer authenticate.
      const row = rows.find((site) => site.siteId === siteId && site.revokedAt === null);
      if (row !== undefined) {
        const secret = secretStorage.read(row.credentialRef);
        if (secret !== undefined) yield* revokeWordPressGrant(row.endpoint, row.grantId, secret);
        secretStorage.delete(row.credentialRef);
      }
      rows = rows.map((site) =>
        site.siteId === siteId && site.revokedAt === null
          ? { ...site, revokedAt: new Date().toISOString() }
          : site,
      );
      notify();
      yield* runPersist();
    });

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
    if (existing >= 0) {
      secretStorage.delete(rows[existing]!.credentialRef);
      rows = [...rows.slice(0, existing), row, ...rows.slice(existing + 1)];
    } else {
      rows = [...rows, row];
    }
    secretStorage.write(credentialRef, grantSecret);
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
      const secret = secretStorage.read(credentialRef);
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
      const file = path.join(directory, "connections.json");
      const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "[]"));
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "load",
            message: "Connection directory is not valid JSON; starting empty.",
          }),
      }).pipe(Effect.orElseSucceed(() => [] as unknown));
      const decoded = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(RegistryStateSchema)(
            parsed,
          ) as ReadonlyArray<StoredZeroYSiteRow>,
        catch: () =>
          new ZeroYConnectionRegistryError({
            operation: "load",
            message: "Connection directory is corrupt; starting empty.",
          }),
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<StoredZeroYSiteRow>));
      rows = decoded;
      // Grant secrets survive restarts: persist() writes secrets.json, so
      // load() must restore it into the in-memory storage. Custom
      // SecretStorage implementations own their own persistence and are
      // never touched here.
      if (secretStorage instanceof InMemorySecretStorage) {
        const secretsFile = path.join(directory, "secrets.json");
        const rawSecrets = yield* fs
          .readFileString(secretsFile)
          .pipe(Effect.orElseSucceed(() => "{}"));
        const parsedSecrets = yield* Effect.try({
          try: () => JSON.parse(rawSecrets) as unknown,
          catch: () => ({}),
        }).pipe(Effect.orElseSucceed(() => ({})));
        if (typeof parsedSecrets === "object" && parsedSecrets !== null) {
          for (const [ref, secret] of Object.entries(parsedSecrets as Record<string, unknown>)) {
            if (typeof secret === "string") secretStorage.write(ref, secret);
          }
        }
      }
    });

  const persist = (
    directory: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(directory, { recursive: true });
      const file = path.join(directory, "connections.json");
      yield* fs.writeFileString(file, JSON.stringify(rows, null, 2));
      yield* fs.chmod(file, 0o600);
      const secretsFile = path.join(directory, "secrets.json");
      const secrets =
        secretStorage instanceof InMemorySecretStorage
          ? Object.fromEntries(secretStorage["secrets"])
          : {};
      yield* fs.writeFileString(secretsFile, JSON.stringify(secrets, null, 2));
      yield* fs.chmod(secretsFile, 0o600);
    }).pipe(Effect.catch(() => Effect.void));

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
