import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { makeStateStore, type StateStore } from "../src/state.ts";

export const withTestStore = <A, E>(
  use: (store: StateStore) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  processedLimit = 512,
): Effect.Effect<A, E | PlatformError, never> =>
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
    yield* store.bind({ sessionId: "pi-session", cwd: "/tmp" });
  });
