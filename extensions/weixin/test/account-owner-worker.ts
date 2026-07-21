import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { NodeRuntime } from "@effect/platform-node";
import { ConfigProvider, Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Bridge, BridgeLive } from "../src/bridge.ts";

const [home, statePath] = process.argv.slice(2);
if (home === undefined || statePath === undefined) process.exit(64);

const live = BridgeLive.pipe(
  Layer.provide(Layer.merge(NodeServicesLayer, FetchHttpClient.layer)),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        HOME: home,
        PI_WEIXIN_STATE_PATH: statePath,
        PIPEE_BASE_URL: "http://127.0.0.1:9",
      }),
    ),
  ),
);

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(live);
      const bridge = Context.get(context, Bridge);
      yield* bridge.start;
      yield* Effect.sync(() => process.stdout.write("acquired\n"));
      return yield* Effect.never;
    }),
  ).pipe(
    Effect.catchTag("BridgeOwnershipConflict", () =>
      Effect.sync(() => process.stdout.write("unavailable\n")),
    ),
  ),
);
