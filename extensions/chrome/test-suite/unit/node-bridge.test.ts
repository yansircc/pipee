import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { createServer } from "node:http";
import { decodePollResponseJson } from "../../src/protocol/codec.js";
import type { ProfileConnector } from "../../src/protocol/schema.js";
import { makeConnectorBindingStore } from "../../src/pi/connector-binding.js";
import { EXTENSION_PACKAGE_ID } from "../../src/pi/extension-package.js";
import { NodeBridge } from "../../src/pi/node-bridge.js";
import { nodeProtocolFingerprint } from "../../src/pi/node-protocol-fingerprint.js";
import { authenticatedBridgeRequest } from "./bridge-auth-fixture.js";

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const freePort = Effect.callback<number, TestFailure>((resume) => {
  const server = createServer();
  const onError = (cause: unknown) =>
    resume(Effect.fail(new TestFailure({ message: "port", cause })));
  server.once("error", onError);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError);
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : undefined;
    server.close(() =>
      resume(
        port === undefined
          ? Effect.fail(new TestFailure({ message: "missing TCP port" }))
          : Effect.succeed(port),
      ),
    );
  });
  return Effect.sync(() => server.close());
});

const connectorRequest = (
  baseUrl: string,
  routeName: "poll" | "result",
  connector: ProfileConnector,
  body = "",
) =>
  authenticatedBridgeRequest(
    baseUrl,
    "connectorHandshake",
    routeName,
    "connectorServerProof",
    "connectorRequestProof",
    connector.secret,
    connector,
    body,
  );

const waitUntilConnected = (bridge: NodeBridge) =>
  bridge.status.pipe(
    Effect.flatMap((status) =>
      status.connector?.connected
        ? Effect.void
        : Effect.fail(new TestFailure({ message: "connector is not polling yet" })),
    ),
    Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
  );

const withBridge = <A, E>(use: (bridge: NodeBridge) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-bridge-" });
      const port = yield* freePort;
      const store = yield* makeConnectorBindingStore(agentDir);
      const bridge = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", store);
      yield* Effect.addFinalizer(() => bridge.stop);
      yield* bridge.start;
      return yield* use(bridge);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

const liveConnector = nodeProtocolFingerprint.pipe(
  Effect.map(
    (protocolFingerprint): ProfileConnector => ({
      connectorId: "11111111-1111-4111-8111-111111111111",
      secret: "a".repeat(64),
      label: "Personal Chrome",
      extensionId: EXTENSION_PACKAGE_ID,
      extensionDisplayVersion: "0.16.0",
      protocolFingerprint,
    }),
  ),
);

const session = {
  key: "session:connector-routing",
  groupTitle: "Pi Session: connector routing",
  foreground: false,
} as const;

it.effect("constructs the bridge synchronously at the Pi extension boundary", () =>
  Effect.gen(function* () {
    const store = yield* makeConnectorBindingStore("/tmp/pi-chrome-sync-construction");
    yield* NodeBridge.make("127.0.0.1", 17318, () => "0.16.0", store);
  }),
);

it.live("auto-registers the first compatible connector and delivers commands", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const connector = yield* liveConnector;
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);
      const sender = yield* Effect.forkChild(
        bridge.send({ domain: "tab", call: { op: "list" } }, session, 2_000),
      );
      const response = yield* Fiber.join(poll);
      const envelope = yield* decodePollResponseJson(response.text);
      expect(envelope.type).toBe("command");
      if (envelope.type !== "command") return;
      const accepted = yield* connectorRequest(
        bridge.url,
        "result",
        connector,
        JSON.stringify({ id: envelope.command.id, ok: true, value: [] }),
      );
      expect(accepted.status).toBe(200);
      expect(yield* Fiber.join(sender)).toEqual([]);
      expect(yield* bridge.status).toMatchObject({
        binding: { connectorId: connector.connectorId },
        connector: { connected: true },
      });
    }),
  ),
);

it.live("stops immediately while an automatically registered connector is polling", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const connector = yield* liveConnector;
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);
      yield* bridge.stop.pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(new TestFailure({ message: "bridge stop waited for connector poll" })),
        }),
      );
      yield* Fiber.await(poll).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new TestFailure({ message: "connector poll remained active" })),
        }),
      );
      expect((yield* bridge.status).mode).toBe("closed");
    }),
  ),
);
