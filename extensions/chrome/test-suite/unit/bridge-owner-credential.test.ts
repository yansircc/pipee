import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  BridgeOwnerCredentialFailure,
  makeBridgeOwnerCredentialStore,
} from "../../src/pi/bridge-owner-credential.js";
import { assertPosixFileMode } from "../support/posix-file-mode.js";

const withAgentDirectory = <A, E>(
  use: (
    agentDir: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-" });
      return yield* use(agentDir, fs, path);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

it.effect("creates one restricted credential across concurrent store instances", () =>
  withAgentDirectory((agentDir, fs, path) =>
    Effect.gen(function* () {
      const stores = yield* Effect.forEach(Array.from({ length: 24 }), () =>
        makeBridgeOwnerCredentialStore(agentDir),
      );
      const credentials = yield* Effect.all(
        stores.map((store) => store.loadOrCreate),
        { concurrency: "unbounded" },
      );

      expect(new Set(credentials).size).toBe(1);
      expect(credentials[0]).toMatch(/^[0-9a-f]{64}$/);
      const filePath = yield* stores[0]!.filePath;
      assertPosixFileMode((yield* fs.stat(path.dirname(filePath))).mode, 0o700);
      assertPosixFileMode((yield* fs.stat(filePath)).mode, 0o600);
    }),
  ),
);

it.live("fails closed on a malformed persisted owner credential", () =>
  withAgentDirectory((agentDir, fs, path) =>
    Effect.gen(function* () {
      const store = yield* makeBridgeOwnerCredentialStore(agentDir);
      const filePath = yield* store.filePath;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, JSON.stringify({ version: 1, credential: "weak" }));

      const failure = yield* store.loadOrCreate.pipe(Effect.flip);
      expect(failure).toBeInstanceOf(BridgeOwnerCredentialFailure);
      expect(failure.path).toBe(filePath);
    }),
  ),
);

it.live("rejects an oversized persisted owner credential before reading it", () =>
  withAgentDirectory((agentDir, fs, path) =>
    Effect.gen(function* () {
      const store = yield* makeBridgeOwnerCredentialStore(agentDir);
      const filePath = yield* store.filePath;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "x".repeat(2048));

      const failure = yield* store.loadOrCreate.pipe(Effect.flip);
      expect(failure).toBeInstanceOf(BridgeOwnerCredentialFailure);
      expect(failure.path).toBe(filePath);
      expect(failure.cause).toMatchObject({
        reason: "owner credential exceeds its persisted byte limit",
      });
    }),
  ),
);
