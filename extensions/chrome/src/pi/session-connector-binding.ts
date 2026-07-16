import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  PairingId,
  ProfileConnector,
  Timestamp,
  WebRunLeaseClaim,
  type ProfileConnector as ProfileConnectorType,
  type WebRunLeaseClaim as WebRunLeaseClaimType,
} from "../protocol/schema.js";
import { ConnectorBindingStoreFailure } from "./connector-binding.js";
import { rollbackStagingOnFailure } from "./rollback-staging.js";

const STORE_DIRECTORY = "pi-chrome";
const STORE_FILENAME = "session-connector-bindings.json";
const STORE_BYTE_LIMIT = 256 * 1024;
const STORE_BINDING_LIMIT = 128;

export type PersistedSessionConnectorBinding = Readonly<{
  sessionKey: string;
  generation: string;
  connector: ProfileConnectorType;
  live?: Readonly<{
    claim: WebRunLeaseClaimType;
    expiresAt: number;
  }>;
}>;

const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const PersistedSessionConnectorBindingSchema = Schema.Struct({
  sessionKey: NonBlankString,
  generation: PairingId,
  connector: ProfileConnector,
  live: Schema.optionalKey(
    Schema.Struct({
      claim: WebRunLeaseClaim,
      expiresAt: Timestamp,
    }),
  ),
});

const StoreDocument = Schema.Struct({
  version: Schema.Literal(1),
  bindings: Schema.Array(PersistedSessionConnectorBindingSchema),
});
const JsonStoreDocument = Schema.fromJsonString(StoreDocument);

const storeFailure =
  (operation: "load" | "save", filePath: string) =>
  (cause: unknown): ConnectorBindingStoreFailure =>
    new ConnectorBindingStoreFailure({
      operation,
      path: filePath,
      message: `Failed to ${operation} the Chrome session connector bindings at ${filePath}`,
      cause,
    });

export interface SessionConnectorBindingPersistence {
  readonly load: Effect.Effect<
    ReadonlyArray<PersistedSessionConnectorBinding>,
    ConnectorBindingStoreFailure,
    FileSystem.FileSystem | Path.Path
  >;
  readonly save: (
    bindings: ReadonlyArray<PersistedSessionConnectorBinding>,
  ) => Effect.Effect<void, ConnectorBindingStoreFailure, FileSystem.FileSystem | Path.Path>;
}

class SessionConnectorBindingStore implements SessionConnectorBindingPersistence {
  private constructor(
    private readonly agentDir: string,
    private readonly mutationLock: Semaphore.Semaphore,
  ) {}

  static make = (agentDir: string) =>
    Effect.sync(() => new SessionConnectorBindingStore(agentDir, Semaphore.makeUnsafe(1)));

  private get paths() {
    const agentDir = this.agentDir;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = path.join(agentDir, STORE_DIRECTORY);
      return { directory, filePath: path.join(directory, STORE_FILENAME) } as const;
    });
  }

  get load(): SessionConnectorBindingPersistence["load"] {
    const paths = this.paths;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { filePath } = yield* paths;
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(storeFailure("load", filePath)));
      if (!exists) return [];
      const info = yield* fs.stat(filePath).pipe(Effect.mapError(storeFailure("load", filePath)));
      if (info.size > BigInt(STORE_BYTE_LIMIT)) {
        return yield* storeFailure(
          "load",
          filePath,
        )({
          reason: "session connector binding store exceeds its byte limit",
          actualBytes: info.size,
          limitBytes: STORE_BYTE_LIMIT,
        });
      }
      const encoded = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError(storeFailure("load", filePath)));
      const document = yield* Schema.decodeUnknownEffect(JsonStoreDocument)(encoded).pipe(
        Effect.mapError(storeFailure("load", filePath)),
      );
      if (document.bindings.length > STORE_BINDING_LIMIT) {
        return yield* storeFailure(
          "load",
          filePath,
        )({
          reason: "session connector binding store exceeds its binding limit",
          actualBindings: document.bindings.length,
          limitBindings: STORE_BINDING_LIMIT,
        });
      }
      const sessionKeys = new Set(document.bindings.map(({ sessionKey }) => sessionKey));
      if (sessionKeys.size !== document.bindings.length) {
        return yield* storeFailure(
          "load",
          filePath,
        )({
          reason: "session connector binding store contains duplicate session keys",
        });
      }
      const incoherent = document.bindings.find(
        ({ sessionKey, generation, connector, live }) =>
          live !== undefined &&
          (live.claim.sessionKey !== sessionKey ||
            live.claim.pairingId !== generation ||
            live.claim.connectorId !== connector.connectorId),
      );
      if (incoherent) {
        return yield* storeFailure(
          "load",
          filePath,
        )({
          reason: "session connector binding store contains an incoherent live route",
          sessionKey: incoherent.sessionKey,
        });
      }
      const connectorAuthority = new Map<string, ProfileConnectorType>();
      for (const binding of document.bindings) {
        const existing = connectorAuthority.get(binding.connector.connectorId);
        if (
          existing &&
          (existing.secret !== binding.connector.secret ||
            existing.extensionId !== binding.connector.extensionId)
        ) {
          return yield* storeFailure(
            "load",
            filePath,
          )({
            reason: "session connector bindings contain conflicting connector authority",
            connectorId: binding.connector.connectorId,
          });
        }
        connectorAuthority.set(binding.connector.connectorId, binding.connector);
      }
      return document.bindings;
    });
  }

  save(
    bindings: ReadonlyArray<PersistedSessionConnectorBinding>,
  ): Effect.Effect<void, ConnectorBindingStoreFailure, FileSystem.FileSystem | Path.Path> {
    const paths = this.paths;
    const save = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, filePath } = yield* paths;
      if (bindings.length > STORE_BINDING_LIMIT) {
        return yield* storeFailure(
          "save",
          filePath,
        )({
          reason: "session connector binding store exceeds its binding limit",
          actualBindings: bindings.length,
          limitBindings: STORE_BINDING_LIMIT,
        });
      }
      const encoded = yield* Schema.encodeUnknownEffect(JsonStoreDocument)({
        version: 1,
        bindings,
      }).pipe(Effect.mapError(storeFailure("save", filePath)));
      if (Buffer.byteLength(encoded, "utf8") > STORE_BYTE_LIMIT) {
        return yield* storeFailure(
          "save",
          filePath,
        )({
          reason: "session connector binding store exceeds its byte limit",
          limitBytes: STORE_BYTE_LIMIT,
        });
      }
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(storeFailure("save", filePath)));
      yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(storeFailure("save", filePath)));
      const temporaryPath = path.join(
        directory,
        `.${STORE_FILENAME}.staging-${globalThis.crypto.randomUUID()}`,
      );
      const replace = Effect.gen(function* () {
        yield* fs.writeFileString(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
        yield* fs.chmod(temporaryPath, 0o600);
        yield* fs.rename(temporaryPath, filePath);
      }).pipe(Effect.mapError(storeFailure("save", filePath)));
      const rollback = fs
        .remove(temporaryPath, { force: true })
        .pipe(Effect.mapError(storeFailure("save", temporaryPath)));
      yield* rollbackStagingOnFailure(replace, rollback);
    });
    return this.mutationLock.withPermits(1)(save);
  }
}

export const makeSessionConnectorBindingStore = (agentDir: string) =>
  SessionConnectorBindingStore.make(agentDir);
