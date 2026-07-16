import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import type { BoundConnector } from "../../src/protocol/schema.js";
import {
  ConnectorBindingStore,
  ConnectorBindingStoreFailure,
  makeConnectorBindingStore,
} from "../../src/pi/connector-binding.js";
import { makeSessionConnectorBindingStore } from "../../src/pi/session-connector-binding.js";
import { assertPosixFileMode } from "../support/posix-file-mode.js";

const binding = {
  connectorId: "00000000-0000-4000-8000-000000000001",
  secret: "a".repeat(64),
  label: "Personal Chrome",
  extensionId: "a".repeat(32),
  extensionDisplayVersion: "0.17.0",
  protocolFingerprint: "a".repeat(64),
  pairedAt: 1_752_420_000_000,
} satisfies BoundConnector;

const injectedFileSystemFailure = (method: string, file: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: file,
    description: "injected connector binding failure",
  });

const withTemporaryStore = <A, E>(
  use: (
    store: ConnectorBindingStore,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-binding-" });
      const store = yield* makeConnectorBindingStore(agentDir);
      return yield* use(store, fs, path);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

it.effect("atomically persists one user-level connector binding", () =>
  withTemporaryStore((store, fs, path) =>
    Effect.gen(function* () {
      expect(yield* store.load).toBeUndefined();

      yield* store.save(binding);

      const filePath = yield* store.filePath;
      expect(yield* store.load).toEqual(binding);
      expect(yield* fs.readDirectory(path.dirname(filePath))).toEqual([
        "profile-connector-binding.json",
      ]);
      assertPosixFileMode((yield* fs.stat(path.dirname(filePath))).mode, 0o700);
      assertPosixFileMode((yield* fs.stat(filePath)).mode, 0o600);
    }),
  ),
);

it.effect("loads the published v1 session binding document", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-session-binding-" });
      const directory = path.join(agentDir, "pi-chrome");
      yield* fs.makeDirectory(directory, { recursive: true });
      const fixture = yield* fs.readFileString(
        fileURLToPath(
          new URL(
            "../../../../tests/upgrade-fixtures/pi-chrome-session-bindings-v1.json",
            import.meta.url,
          ),
        ),
      );
      yield* fs.writeFileString(path.join(directory, "session-connector-bindings.json"), fixture);

      const store = yield* makeSessionConnectorBindingStore(agentDir);
      expect(yield* store.load).toEqual([]);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("ignores the incompatible legacy binding file without migration", () =>
  withTemporaryStore((store, fs, path) =>
    Effect.gen(function* () {
      const filePath = yield* store.filePath;
      const directory = path.dirname(filePath);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "connector-binding.json"),
        JSON.stringify({
          connectorId: "legacy",
          secret: "legacy-connector-secret-32-bytes-value",
          label: "Legacy Chrome",
          extensionId: "legacy-extension",
          ["extension" + "Version"]: "0.16.0",
          pairedAt: 1,
        }),
      );

      expect(yield* store.load).toBeUndefined();
      expect(yield* fs.exists(filePath)).toBe(false);
    }),
  ),
);

it.effect("fails closed on malformed persisted data", () =>
  withTemporaryStore((store, fs, path) =>
    Effect.gen(function* () {
      const filePath = yield* store.filePath;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, JSON.stringify({ connectorId: "incomplete" }));

      const failure = yield* store.load.pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ConnectorBindingStoreFailure);
      expect(failure).toMatchObject({ operation: "load", path: filePath });
    }),
  ),
);

it.effect("rejects an oversized binding before reading it into memory", () =>
  withTemporaryStore((store, fs, path) =>
    Effect.gen(function* () {
      const filePath = yield* store.filePath;
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "x".repeat(20_000));
      const injected = Object.assign(Object.create(fs), {
        readFileString: () => Effect.die("oversized binding must not be read"),
      }) as FileSystem.FileSystem;

      const failure = yield* store.load.pipe(
        Effect.provideService(FileSystem.FileSystem, injected),
        Effect.flip,
      );
      expect(failure).toMatchObject({
        _tag: "ConnectorBindingStoreFailure",
        operation: "load",
        path: filePath,
      });
    }),
  ),
);

it.effect("does not replace a valid binding with invalid runtime input", () =>
  withTemporaryStore((store) =>
    Effect.gen(function* () {
      yield* store.save(binding);
      const invalid = { ...binding, pairedAt: "not-a-timestamp" } as unknown as BoundConnector;

      expect((yield* Effect.exit(store.save(invalid)))._tag).toBe("Failure");
      expect(yield* store.load).toEqual(binding);
    }),
  ),
);

it.effect("reports the secret-bearing staging path when rollback cleanup fails", () =>
  withTemporaryStore((store, fs, path) =>
    Effect.gen(function* () {
      const injected = Object.assign(Object.create(fs), {
        rename: (from: string, to: string) =>
          from.includes(".staging-")
            ? Effect.fail(injectedFileSystemFailure("rename", from))
            : fs.rename(from, to),
        remove: (file: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) =>
          file.includes(".staging-")
            ? Effect.fail(injectedFileSystemFailure("remove", file))
            : fs.remove(file, options),
      }) as FileSystem.FileSystem;

      const attempted = yield* Effect.exit(
        store.save(binding).pipe(Effect.provideService(FileSystem.FileSystem, injected)),
      );

      expect(attempted._tag).toBe("Failure");
      if (attempted._tag === "Failure") {
        expect(Cause.pretty(attempted.cause)).toContain(".staging-");
        expect(Cause.pretty(attempted.cause)).toContain("Failed to save");
      }
      const directory = path.dirname(yield* store.filePath);
      expect(
        (yield* fs.readDirectory(directory)).some((entry) => entry.includes(".staging-")),
      ).toBe(true);
    }),
  ),
);

it.effect("does not run rollback cleanup after the atomic rename commits", () =>
  withTemporaryStore((store, fs) =>
    Effect.gen(function* () {
      let stagingCleanupAttempts = 0;
      const injected = Object.assign(Object.create(fs), {
        remove: (file: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) => {
          if (file.includes(".staging-")) {
            return Effect.suspend(() => {
              stagingCleanupAttempts += 1;
              return Effect.fail(injectedFileSystemFailure("remove", file));
            });
          }
          return fs.remove(file, options);
        },
      }) as FileSystem.FileSystem;

      yield* store.save(binding).pipe(Effect.provideService(FileSystem.FileSystem, injected));

      expect(stagingCleanupAttempts).toBe(0);
      expect(yield* store.load).toEqual(binding);
    }),
  ),
);

it.effect("clears the binding idempotently", () =>
  withTemporaryStore((store) =>
    Effect.gen(function* () {
      yield* store.save(binding);
      yield* store.clear;
      yield* store.clear;

      expect(yield* store.load).toBeUndefined();
    }),
  ),
);
