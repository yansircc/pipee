import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Scope } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { RouteStoreError, StateStoreError } from "../src/errors.ts";
import { makeStateStore, type StateStore } from "../src/state.ts";

export const withTestStore = <A, E>(
  use: (store: StateStore) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  processedLimit = 512,
): Effect.Effect<A, E | PlatformError | StateStoreError | RouteStoreError, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-" });
      const store = yield* makeStateStore(path.join(directory, "state.json"), processedLimit);
      return yield* use(store);
    }),
  ).pipe(Effect.provide(NodeServicesLayer));

export const configureStore = (store: StateStore) =>
  Effect.gen(function* () {
    yield* store.saveAuth({
      token: "secret",
      baseUrl: "https://example.test",
      accountId: "bot",
      userId: "allowed-user",
      savedAt: "now",
    });
    yield* store.setDefaultSession({ sessionId: "pi-session", cwd: "/tmp" });
    yield* store.setEnabled(true);
  });
