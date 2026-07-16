import { expect, it } from "@effect/vitest";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Stream,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Bridge, BridgeLive, type BridgeStatus } from "../src/bridge.ts";
import type { StateStoreError } from "../src/errors.ts";

it.effect("publishes the current binding and every successful rebind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-bridge-" });
      const config = ConfigProvider.fromUnknown({
        HOME: directory,
        PI_WEIXIN_STATE_PATH: path.join(directory, "state.json"),
        PI_WEB_BASE_URL: "http://127.0.0.1:30141",
      });
      const BridgeTestLive = BridgeLive.pipe(
        Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
        Layer.provide(ConfigProvider.layer(config)),
      );

      yield* Effect.gen(function* () {
        const bridge = yield* Bridge;
        const observed = yield* Ref.make<readonly Exit.Exit<BridgeStatus, StateStoreError>[]>([]);
        const ready = yield* Deferred.make<void>();
        const fiber = yield* bridge.statusChanges.pipe(
          Stream.take(3),
          Stream.runForEach((status) =>
            Ref.updateAndGet(observed, (statuses) => [...statuses, status]).pipe(
              Effect.flatMap((statuses) =>
                statuses.length === 1 ? Deferred.succeed(ready, undefined) : Effect.void,
              ),
              Effect.asVoid,
            ),
          ),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.await(ready);
        yield* bridge.bind({ sessionId: "session-a", cwd: "/tmp/a" });
        yield* bridge.bind({ sessionId: "session-b", cwd: "/tmp/b" });
        yield* Fiber.join(fiber);

        expect(
          (yield* Ref.get(observed)).map(
            Exit.match({
              onFailure: () => "failed",
              onSuccess: (status) => status.sessionId,
            }),
          ),
        ).toEqual([undefined, "session-a", "session-b"]);
      }).pipe(Effect.provide(BridgeTestLive));
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);

it.effect("keeps status subscribers alive after a state read failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-bridge-" });
      const statePath = path.join(directory, "state.json");
      const config = ConfigProvider.fromUnknown({
        HOME: directory,
        PI_WEIXIN_STATE_PATH: statePath,
        PI_WEB_BASE_URL: "http://127.0.0.1:30141",
      });
      const BridgeTestLive = BridgeLive.pipe(
        Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
        Layer.provide(ConfigProvider.layer(config)),
      );

      yield* Effect.gen(function* () {
        const bridge = yield* Bridge;
        const observed = yield* Ref.make<readonly ("success" | "failure")[]>([]);
        const initial = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        const recovered = yield* Deferred.make<void>();
        const fiber = yield* bridge.statusChanges.pipe(
          Stream.take(3),
          Stream.runForEach((status) =>
            Ref.updateAndGet(observed, (statuses) => [
              ...statuses,
              Exit.isSuccess(status) ? ("success" as const) : ("failure" as const),
            ]).pipe(
              Effect.flatMap((statuses) =>
                statuses.length === 1
                  ? Deferred.succeed(initial, undefined)
                  : statuses.length === 2
                    ? Deferred.succeed(failed, undefined)
                    : Deferred.succeed(recovered, undefined),
              ),
              Effect.asVoid,
            ),
          ),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Deferred.await(initial);
        yield* fs.writeFileString(statePath, "{");
        yield* bridge.stop;
        yield* Deferred.await(failed);
        yield* fs.remove(statePath);
        yield* bridge.stop;
        yield* Deferred.await(recovered);
        yield* Fiber.join(fiber);

        expect(yield* Ref.get(observed)).toEqual(["success", "failure", "success"]);
      }).pipe(Effect.provide(BridgeTestLive));
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);
