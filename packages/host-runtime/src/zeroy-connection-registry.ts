import {
  ZEROY_CONNECTION_REGISTRY_CAPABILITY,
  type ZeroYConnectionRegistryPort,
  type ZeroYSiteConnectionProjectionList,
} from "@pipee/companion-contracts/zeroy-connection-registry";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

/**
 * Pipee-owned zeroY connection registry (persistence layer).
 *
 * Facts owned here:
 * - The connection directory (non-sensitive metadata: siteId, label,
 *   endpoint, grantId, credentialRef, timestamps, revocation state).
 * - Grant secrets (credentialRef -> grant plaintext) in protected storage.
 *   Never returned to UI, logs, or the extension projection.
 *
 * The WordPress plugin owns site identity, grant hashes, and revocation.
 * Pairing orchestration (authorization URL, callback exchange) is driven by
 * the Pipee HTTP service through the injected callbacks; this module only
 * persists and projects the resulting connection facts.
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
  const secretStorage: SecretStorage = callbacks.secretStorage ?? new InMemorySecretStorage();

  const notify = (): void => {
    if (disposed) return;
    for (const listener of listeners) listener();
  };

  const provider: ZeroYConnectionRegistryPort = {
    list: () =>
      ({
        contract: "pipee/zeroy-connection-directory@1",
        observedAt: new Date().toISOString(),
        sites: rows.map(toProjectionSite),
      }) as unknown as ZeroYSiteConnectionProjectionList,
    beginPairing: () => {
      throw new ZeroYConnectionRegistryError({
        operation: "begin-pairing",
        message: "Pairing orchestration is owned by the Pipee HTTP service.",
      });
    },
    exchangeCode: () => {
      throw new ZeroYConnectionRegistryError({
        operation: "exchange-code",
        message: "Pairing orchestration is owned by the Pipee HTTP service.",
      });
    },
    revoke: (siteId) => {
      rows = rows.map((site) =>
        site.siteId === siteId && site.revokedAt === null
          ? { ...site, revokedAt: new Date().toISOString() }
          : site,
      );
      const row = rows.find((site) => site.siteId === siteId);
      if (row !== undefined) secretStorage.delete(row.credentialRef);
      notify();
    },
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
    upsert: (input, grantSecret) => {
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
    },
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
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
    },
  };
};

export { ZEROY_CONNECTION_REGISTRY_CAPABILITY };
