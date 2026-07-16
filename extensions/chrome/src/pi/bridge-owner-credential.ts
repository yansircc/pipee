import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HEX_256_PATTERN } from "../protocol/hex-256.js";

const STORE_DIRECTORY = "pi-chrome";
const STORE_FILENAME = "owner-credential.json";
const OWNER_CREDENTIAL_BYTE_LIMIT = 1024;

const OwnerCredentialRecord = Schema.Struct({
  version: Schema.Literal(1),
  credential: Schema.String.check(Schema.isPattern(HEX_256_PATTERN)),
});
const JsonOwnerCredentialRecord = Schema.fromJsonString(OwnerCredentialRecord);

type OwnerCredentialRecord = Schema.Schema.Type<typeof OwnerCredentialRecord>;

export class BridgeOwnerCredentialFailure extends Data.TaggedError("BridgeOwnerCredentialFailure")<{
  readonly path: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const failure = (filePath: string, cause: unknown) =>
  new BridgeOwnerCredentialFailure({
    path: filePath,
    message: `Failed to load or create the bridge owner credential at ${filePath}`,
    cause,
  });

const freshRecord = (): OwnerCredentialRecord => ({
  version: 1,
  credential: [...globalThis.crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(""),
});

export class BridgeOwnerCredentialStore {
  private constructor(readonly agentDir: string) {}

  static make = (agentDir: string = getAgentDir()) =>
    Effect.sync(() => new BridgeOwnerCredentialStore(agentDir));

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

  get loadOrCreate(): Effect.Effect<
    string,
    BridgeOwnerCredentialFailure,
    FileSystem.FileSystem | Path.Path
  > {
    const paths = this.paths;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { directory, filePath } = yield* paths;
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => failure(filePath, cause)));
      yield* fs.chmod(directory, 0o700).pipe(Effect.mapError((cause) => failure(filePath, cause)));

      const candidate = freshRecord();
      const encoded = yield* Schema.encodeUnknownEffect(JsonOwnerCredentialRecord)(candidate).pipe(
        Effect.mapError((cause) => failure(filePath, cause)),
      );
      const readExisting = Effect.gen(function* () {
        const info = yield* fs.stat(filePath);
        if (info.size > BigInt(OWNER_CREDENTIAL_BYTE_LIMIT)) {
          return yield* failure(filePath, {
            reason: "owner credential exceeds its persisted byte limit",
            actualBytes: info.size,
            limitBytes: OWNER_CREDENTIAL_BYTE_LIMIT,
          });
        }
        const encoded = yield* fs.readFileString(filePath);
        return yield* Schema.decodeUnknownEffect(JsonOwnerCredentialRecord)(encoded);
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof BridgeOwnerCredentialFailure ? cause : failure(filePath, cause),
        ),
        Effect.retry({ times: 20, schedule: Schedule.spaced("10 millis") }),
      );
      const record = yield* fs.writeFileString(filePath, encoded, { flag: "wx", mode: 0o600 }).pipe(
        Effect.as(candidate),
        Effect.catchTag("PlatformError", (cause) =>
          cause.reason._tag === "AlreadyExists"
            ? readExisting
            : Effect.fail(failure(filePath, cause)),
        ),
      );
      yield* fs.chmod(filePath, 0o600).pipe(Effect.mapError((cause) => failure(filePath, cause)));
      return record.credential;
    });
  }
}

export const makeBridgeOwnerCredentialStore = (agentDir: string = getAgentDir()) =>
  BridgeOwnerCredentialStore.make(agentDir);
