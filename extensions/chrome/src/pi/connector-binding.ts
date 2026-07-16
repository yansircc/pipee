import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { BoundConnector as BoundConnectorSchema, type BoundConnector } from "../protocol/schema.js";
import { rollbackStagingOnFailure } from "./rollback-staging.js";

const STORE_DIRECTORY = "pi-chrome";
const STORE_FILENAME = "profile-connector-binding.json";
const CONNECTOR_BINDING_BYTE_LIMIT = 16 * 1024;

type StoreOperation = "load" | "save" | "clear";

export class ConnectorBindingStoreFailure extends Data.TaggedError("ConnectorBindingStoreFailure")<{
  readonly operation: StoreOperation;
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const JsonBoundConnector = Schema.fromJsonString(BoundConnectorSchema);

const storeFailure = (operation: StoreOperation, filePath: string) => (cause: unknown) =>
  new ConnectorBindingStoreFailure({
    operation,
    path: filePath,
    message: `Failed to ${operation} the Chrome profile connector binding at ${filePath}`,
    cause,
  });

export class ConnectorBindingStore {
  private constructor(
    readonly agentDir: string,
    private readonly mutationLock: Semaphore.Semaphore,
  ) {}

  static make = (agentDir: string = getAgentDir()) =>
    Effect.sync(() => new ConnectorBindingStore(agentDir, Semaphore.makeUnsafe(1)));

  private get paths() {
    const agentDir = this.agentDir;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = path.join(agentDir, STORE_DIRECTORY);
      return { directory, filePath: path.join(directory, STORE_FILENAME) } as const;
    });
  }

  get filePath(): Effect.Effect<string, never, Path.Path> {
    return this.paths.pipe(Effect.map(({ filePath }) => filePath));
  }

  get load(): Effect.Effect<
    BoundConnector | undefined,
    ConnectorBindingStoreFailure,
    FileSystem.FileSystem | Path.Path
  > {
    const paths = this.paths;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { filePath } = yield* paths;
      const exists = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(storeFailure("load", filePath)));
      if (!exists) return undefined;
      const info = yield* fs.stat(filePath).pipe(Effect.mapError(storeFailure("load", filePath)));
      if (info.size > BigInt(CONNECTOR_BINDING_BYTE_LIMIT)) {
        return yield* storeFailure(
          "load",
          filePath,
        )({
          reason: "connector binding exceeds its persisted byte limit",
          actualBytes: info.size,
          limitBytes: CONNECTOR_BINDING_BYTE_LIMIT,
        });
      }
      const encoded = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError(storeFailure("load", filePath)));
      return yield* Schema.decodeUnknownEffect(JsonBoundConnector)(encoded).pipe(
        Effect.mapError(storeFailure("load", filePath)),
      );
    });
  }

  save(
    binding: BoundConnector,
  ): Effect.Effect<void, ConnectorBindingStoreFailure, FileSystem.FileSystem | Path.Path> {
    const paths = this.paths;
    const save = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, filePath } = yield* paths;
      const encoded = yield* Schema.encodeUnknownEffect(JsonBoundConnector)(binding).pipe(
        Effect.mapError(storeFailure("save", filePath)),
      );
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
      return yield* rollbackStagingOnFailure(replace, rollback);
    });
    return this.mutationLock.withPermits(1)(save);
  }

  get clear(): Effect.Effect<
    void,
    ConnectorBindingStoreFailure,
    FileSystem.FileSystem | Path.Path
  > {
    const paths = this.paths;
    const clear = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { filePath } = yield* paths;
      yield* fs
        .remove(filePath, { force: true })
        .pipe(Effect.mapError(storeFailure("clear", filePath)));
    });
    return this.mutationLock.withPermits(1)(clear);
  }
}

export const makeConnectorBindingStore = (agentDir: string = getAgentDir()) =>
  ConnectorBindingStore.make(agentDir);
