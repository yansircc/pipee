import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { NodeBridge } from "../../src/pi/node-bridge.js";
import { makeBridgeOwnerCredentialStore } from "../../src/pi/bridge-owner-credential.js";
import { nodeProtocolFingerprint } from "../../src/pi/node-protocol-fingerprint.js";

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

const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Effect.Effect<{ readonly server: Server; readonly port: number }, TestFailure> =>
  Effect.callback((resume) => {
    const server = createServer(handler);
    const onError = (cause: unknown) =>
      resume(Effect.fail(new TestFailure({ message: "listener failed", cause })));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : undefined;
      resume(
        port === undefined
          ? Effect.fail(new TestFailure({ message: "listener returned no port" }))
          : Effect.succeed({ server, port }),
      );
    });
    return Effect.sync(() => server.close());
  });

const close = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

it.live("rejects an unrelated listener during owner election", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-rogue-" });
      const fingerprint = yield* nodeProtocolFingerprint;
      const observedHeaders: Array<IncomingMessage["headers"]> = [];
      const listener = yield* listen((incoming, response) => {
        observedHeaders.push(incoming.headers);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            bridgeDisplayVersion: "0.16.0",
            protocolFingerprint: fingerprint,
            bridgeEpoch: "b".repeat(64),
            requestNonce: "c".repeat(64),
            proof: "d".repeat(64),
          }),
        );
      });
      yield* Effect.addFinalizer(() => close(listener.server));
      const bridge = yield* NodeBridge.make("127.0.0.1", listener.port, () => "0.16.0", agentDir);
      yield* Effect.addFinalizer(() => bridge.stop);

      expect((yield* Effect.exit(bridge.start))._tag).toBe("Failure");
      expect((yield* bridge.status).mode).toBe("stopped");
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const credential = yield* credentialStore.loadOrCreate;
      expect(observedHeaders).toHaveLength(1);
      expect(JSON.stringify(observedHeaders)).not.toContain(credential);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("rejects a client from a different user credential directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ownerDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-a-" });
      const clientDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-b-" });
      const port = yield* freePort;
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerDir);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientDir);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      const failure = yield* client.start.pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "BridgeUnavailable" });
      expect(failure.message).toContain("prove owner credential possession");
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("shares one bridge across clients without connector bindings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-shared-" });
      const port = yield* freePort;
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", agentDir);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.17.0", agentDir);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      yield* client.start;
      expect((yield* client.status).mode).toBe("client");
      expect(yield* client.status).not.toHaveProperty("binding");
      expect(yield* client.status).not.toHaveProperty("sessionRoutes");
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);
