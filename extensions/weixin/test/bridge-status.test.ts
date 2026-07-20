import { expect, it } from "@effect/vitest";
import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import {
  Cause,
  ConfigProvider,
  Context,
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
import {
  BridgeConfigurationError,
  BridgeOwnershipConflict,
  type StateStoreError,
} from "../src/errors.ts";

it.effect("rejects proactive send until an inbound context token exists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-send-" });
      const statePath = path.join(directory, "state.json");
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({
          version: 3,
          enabled: false,
          cursor: "",
          processedMessageIds: [],
          auth: {
            token: "secret",
            baseUrl: "http://127.0.0.1:9",
            accountId: "account",
            userId: "user",
            savedAt: "now",
          },
          defaultSession: { sessionId: "session", cwd: directory },
        }),
      );
      const live = BridgeLive.pipe(
        Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: directory,
              PI_WEIXIN_STATE_PATH: statePath,
              PIPEE_BASE_URL: "http://127.0.0.1:30141",
            }),
          ),
        ),
      );
      const error = yield* Effect.gen(function* () {
        const bridge = yield* Bridge;
        return yield* bridge.sendText("session", "report", "client").pipe(Effect.flip);
      }).pipe(Effect.provide(live));
      expect(error).toBeInstanceOf(BridgeConfigurationError);
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);

it.effect("publishes the global default session and every successful change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-bridge-" });
      const config = ConfigProvider.fromUnknown({
        HOME: directory,
        PI_WEIXIN_STATE_PATH: path.join(directory, "state.json"),
        PIPEE_BASE_URL: "http://127.0.0.1:30141",
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
        yield* bridge.setDefaultSession({ sessionId: "session-a", cwd: "/tmp/a" });
        yield* bridge.setDefaultSession({ sessionId: "session-b", cwd: "/tmp/b" });
        yield* Fiber.join(fiber);

        expect(
          (yield* Ref.get(observed)).map(
            Exit.match({
              onFailure: () => "failed",
              onSuccess: (status) => status.defaultSessionId,
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
        PIPEE_BASE_URL: "http://127.0.0.1:30141",
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

it.effect("admits one process owner for a state path", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-owner-" });
      const config = ConfigProvider.fromUnknown({
        HOME: directory,
        PI_WEIXIN_STATE_PATH: path.join(directory, "state.json"),
        PIPEE_BASE_URL: "http://127.0.0.1:30141",
      });
      const makeLayer = () =>
        Layer.fresh(BridgeLive).pipe(
          Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
          Layer.provide(ConfigProvider.layer(config)),
        );

      yield* Layer.build(makeLayer());
      const contender = yield* Effect.exit(Layer.build(makeLayer()));
      expect(Exit.isFailure(contender)).toBe(true);
      if (Exit.isFailure(contender)) {
        expect(Cause.squash(contender.cause)).toBeInstanceOf(BridgeOwnershipConflict);
      }
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);

it.effect("admits one poller for an account across distinct state paths", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-weixin-account-" });
      const state = {
        version: 2,
        enabled: true,
        cursor: "",
        processedMessageIds: [],
        auth: {
          token: "secret",
          baseUrl: "http://127.0.0.1:9",
          accountId: "shared-account",
          userId: "user",
          savedAt: "now",
        },
        binding: { sessionId: "session", cwd: directory },
      } as const;
      const stateA = path.join(directory, "a.json");
      const stateB = path.join(directory, "b.json");
      yield* fs.writeFileString(stateA, JSON.stringify(state));
      yield* fs.writeFileString(stateB, JSON.stringify(state));
      const makeLayer = (statePath: string) =>
        Layer.fresh(BridgeLive).pipe(
          Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                HOME: directory,
                PI_WEIXIN_STATE_PATH: statePath,
                PIPEE_BASE_URL: "http://127.0.0.1:30141",
              }),
            ),
          ),
        );

      const ownerContext = yield* Layer.build(makeLayer(stateA));
      const contenderContext = yield* Layer.build(makeLayer(stateB));
      const owner = Context.get(ownerContext, Bridge);
      const contender = Context.get(contenderContext, Bridge);
      expect(yield* owner.start).toBe(true);
      const result = yield* Effect.exit(contender.start);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBeInstanceOf(BridgeOwnershipConflict);
      }
    }),
  ).pipe(Effect.provide(NodeServicesLayer)),
);
