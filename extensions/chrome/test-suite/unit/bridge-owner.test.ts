import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import {
  freshAuthenticationToken,
  hashBridgeRequestBody,
  hasValidOwnerServerProof,
  ownerRequestProof,
  ownerServerProof,
} from "../../src/pi/bridge-authentication-node.js";
import { makeBridgeOwnerCredentialStore } from "../../src/pi/bridge-owner-credential.js";
import { makeConnectorBindingStore } from "../../src/pi/connector-binding.js";
import { EXTENSION_PACKAGE_ID } from "../../src/pi/extension-package.js";
import { NodeBridge } from "../../src/pi/node-bridge.js";
import { nodeProtocolFingerprint } from "../../src/pi/node-protocol-fingerprint.js";
import { decodeBridgeAuthenticationHandshakeJson } from "../../src/protocol/codec.js";
import type { BridgeRequestChallenge } from "../../src/protocol/bridge-authentication.js";
import { BRIDGE_ROUTES, type OwnerBridgeRouteName } from "../../src/protocol/bridge-contract.js";
import {
  OWNER_BODY_SHA256_HEADER,
  OWNER_BRIDGE_EPOCH_HEADER,
  OWNER_CLIENT_NONCE_HEADER,
  OWNER_PROOF_HEADER,
  OWNER_PROTOCOL_FINGERPRINT_HEADER,
  OWNER_REQUEST_NONCE_HEADER,
  type BridgeOwnerIdentity,
} from "../../src/protocol/bridge-owner.js";
import type { BoundConnector, ProfileConnector } from "../../src/protocol/schema.js";
import { pairingRequest } from "./bridge-auth-fixture.js";

class TestFailure extends Data.TaggedError("TestFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const freePort = Effect.callback<number, TestFailure>((resume) => {
  const server = createServer();
  const onError = (cause: unknown) =>
    resume(Effect.fail(new TestFailure({ message: "port allocation failed", cause })));
  server.once("error", onError);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", onError);
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : undefined;
    server.close(() =>
      resume(
        port === undefined
          ? Effect.fail(new TestFailure({ message: "port allocation returned no port" }))
          : Effect.succeed(port),
      ),
    );
  });
  return Effect.sync(() => server.close());
});

const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(url, { ...init, signal }).then((response) =>
        response.text().then((text) => ({ status: response.status, text })),
      ),
    catch: (cause) => new TestFailure({ message: `request failed: ${url}`, cause }),
  });

type AuthenticatedOwnerRouteName = Exclude<OwnerBridgeRouteName, "ownerHandshake">;

const ownerChallenge = (url: string, identity: BridgeOwnerIdentity) =>
  Effect.gen(function* () {
    const clientNonce = freshAuthenticationToken();
    const response = yield* request(`${url}${BRIDGE_ROUTES.ownerHandshake.path}`, {
      method: BRIDGE_ROUTES.ownerHandshake.method,
      headers: {
        [OWNER_CLIENT_NONCE_HEADER]: clientNonce,
        [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
      },
    });
    if (response.status !== 200) {
      return yield* new TestFailure({
        message: `owner handshake returned ${response.status}: ${response.text}`,
      });
    }
    const handshake = yield* decodeBridgeAuthenticationHandshakeJson(response.text);
    const challenge = {
      bridgeEpoch: handshake.bridgeEpoch,
      requestNonce: handshake.requestNonce,
    } satisfies BridgeRequestChallenge;
    if (!hasValidOwnerServerProof(identity, clientNonce, challenge, handshake.proof)) {
      return yield* new TestFailure({ message: "owner handshake proof did not verify" });
    }
    return challenge;
  });

const ownerProofHeaders = (
  identity: BridgeOwnerIdentity,
  routeName: AuthenticatedOwnerRouteName,
  challenge: BridgeRequestChallenge,
  body: string,
): Record<string, string> => {
  const route = BRIDGE_ROUTES[routeName];
  const bodyHash = hashBridgeRequestBody(body);
  return {
    [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
    [OWNER_BRIDGE_EPOCH_HEADER]: challenge.bridgeEpoch,
    [OWNER_REQUEST_NONCE_HEADER]: challenge.requestNonce,
    [OWNER_BODY_SHA256_HEADER]: bodyHash,
    [OWNER_PROOF_HEADER]: ownerRequestProof(identity, {
      ...challenge,
      method: route.method,
      path: route.path,
      bodyHash,
    }),
  };
};

const authenticatedOwnerRequest = (
  url: string,
  identity: BridgeOwnerIdentity,
  routeName: AuthenticatedOwnerRouteName,
  body: string = "",
) =>
  Effect.gen(function* () {
    const challenge = yield* ownerChallenge(url, identity);
    const route = BRIDGE_ROUTES[routeName];
    return yield* request(`${url}${route.path}`, {
      method: route.method,
      headers: ownerProofHeaders(identity, routeName, challenge, body),
      ...(body ? { body } : {}),
    });
  });

type ConnectorFixture = Omit<ProfileConnector, "protocolFingerprint">;

const primary = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  secret: "a".repeat(64),
  label: "Personal Chrome",
  extensionId: EXTENSION_PACKAGE_ID,
  extensionDisplayVersion: "0.16.0",
} satisfies ConnectorFixture;

const secondary = {
  connectorId: "22222222-2222-4222-8222-222222222222",
  secret: "b".repeat(64),
  label: "Smoke Chrome",
  extensionId: EXTENSION_PACKAGE_ID,
  extensionDisplayVersion: "0.16.0",
} satisfies ConnectorFixture;

const pair = (bridge: NodeBridge, fixture: ConnectorFixture) =>
  Effect.gen(function* () {
    const state = yield* bridge.beginPairing();
    const connector = {
      ...fixture,
      protocolFingerprint: state.expectedProtocolFingerprint,
    } satisfies ProfileConnector;
    const response = yield* pairingRequest(bridge.url, state.challenge, connector);
    expect(response.status).toBe(200);
    return connector;
  });

type ListeningServer = { readonly server: Server; readonly port: number };

const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Effect.Effect<ListeningServer, TestFailure> =>
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

it.live("authenticates every owner route with one-time proof and exact protocol fingerprint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-auth-" });
      const port = yield* freePort;
      const store = yield* makeConnectorBindingStore(agentDir);
      const bridge = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", store);
      yield* Effect.addFinalizer(() => bridge.stop);
      yield* bridge.start;

      expect(
        (yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
          method: BRIDGE_ROUTES.status.method,
        })).status,
      ).toBe(409);
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const credential = yield* credentialStore.loadOrCreate;
      const fingerprint = yield* nodeProtocolFingerprint;
      const identity = {
        credential,
        protocolFingerprint: fingerprint,
      } as const;
      expect(
        (yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
          method: BRIDGE_ROUTES.status.method,
          headers: {
            [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
            origin: "http://example.test",
          },
        })).status,
      ).toBe(403);
      expect(
        (yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
          method: BRIDGE_ROUTES.status.method,
          headers: {
            [OWNER_PROTOCOL_FINGERPRINT_HEADER]: identity.protocolFingerprint,
          },
        })).status,
      ).toBe(401);
      expect(
        (yield* request(`${bridge.url}${BRIDGE_ROUTES.ownerHandshake.path}`, {
          method: BRIDGE_ROUTES.ownerHandshake.method,
          headers: {
            [OWNER_CLIENT_NONCE_HEADER]: freshAuthenticationToken(),
            [OWNER_PROTOCOL_FINGERPRINT_HEADER]: "f".repeat(64),
          },
        })).status,
      ).toBe(409);

      const challenge = yield* ownerChallenge(bridge.url, identity);
      const wrongIdentity = { ...identity, credential: "0".repeat(64) };
      const invalid = yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
        method: BRIDGE_ROUTES.status.method,
        headers: ownerProofHeaders(wrongIdentity, "status", challenge, ""),
      });
      expect(invalid.status).toBe(401);

      const invalidReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
        method: BRIDGE_ROUTES.status.method,
        headers: ownerProofHeaders(identity, "status", challenge, ""),
      });
      expect(invalidReplay.status).toBe(401);

      const freshChallenge = yield* ownerChallenge(bridge.url, identity);
      const admitted = yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
        method: BRIDGE_ROUTES.status.method,
        headers: ownerProofHeaders(identity, "status", freshChallenge, ""),
      });
      expect(admitted.status).toBe(200);
      const replay = yield* request(`${bridge.url}${BRIDGE_ROUTES.status.path}`, {
        method: BRIDGE_ROUTES.status.method,
        headers: ownerProofHeaders(identity, "status", freshChallenge, ""),
      });
      expect(replay.status).toBe(401);

      const forgetBody = JSON.stringify({ expectedConnectorId: primary.connectorId });
      const bodyChallenge = yield* ownerChallenge(bridge.url, identity);
      const bodyHeaders = ownerProofHeaders(identity, "forget", bodyChallenge, forgetBody);
      const changedBody = yield* request(`${bridge.url}${BRIDGE_ROUTES.forget.path}`, {
        method: BRIDGE_ROUTES.forget.method,
        headers: { ...bodyHeaders, "content-type": "application/json" },
        body: `${forgetBody} `,
      });
      expect(changedBody.status).toBe(401);
      const changedBodyReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.forget.path}`, {
        method: BRIDGE_ROUTES.forget.method,
        headers: { ...bodyHeaders, "content-type": "application/json" },
        body: forgetBody,
      });
      expect(changedBodyReplay.status).toBe(401);
      expect((yield* authenticatedOwnerRequest(bridge.url, identity, "pairingStart")).status).toBe(
        200,
      );
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

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
      const store = yield* makeConnectorBindingStore(agentDir);
      const bridge = yield* NodeBridge.make("127.0.0.1", listener.port, () => "0.16.0", store);
      yield* Effect.addFinalizer(() => bridge.stop);

      expect((yield* Effect.exit(bridge.start))._tag).toBe("Failure");
      expect((yield* bridge.status).mode).toBe("stopped");
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const credential = yield* credentialStore.loadOrCreate;
      expect(observedHeaders).toHaveLength(1);
      expect(JSON.stringify(observedHeaders)).not.toContain(credential);
      expect(Object.keys(observedHeaders[0]!)).not.toContain("x-pi-chrome-owner-credential");
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
      const ownerStore = yield* makeConnectorBindingStore(ownerDir);
      const clientStore = yield* makeConnectorBindingStore(clientDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      const failure = yield* client.start.pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "BridgeUnavailable" });
      expect(failure.message).toContain("prove owner credential possession");
      expect((yield* client.status).mode).toBe("stopped");
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("allows a same-contract client with a different display version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-version-" });
      const port = yield* freePort;
      const ownerStore = yield* makeConnectorBindingStore(agentDir);
      const clientStore = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.17.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      yield* client.start;
      expect((yield* client.status).mode).toBe("client");
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("rejects a stale client binding before admitting a command", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-route-" });
      const port = yield* freePort;
      const ownerStore = yield* makeConnectorBindingStore(agentDir);
      const clientStore = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      yield* client.start;
      const pairedPrimary = yield* pair(owner, primary);
      yield* clientStore.save({
        ...secondary,
        protocolFingerprint: pairedPrimary.protocolFingerprint,
        pairedAt: 2,
      } satisfies BoundConnector);

      const failure = yield* client
        .send(
          { domain: "tab", call: { op: "list" } },
          { key: "session", groupTitle: "Session", foreground: false },
          500,
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "ConnectorBindingMismatch",
        expectedConnectorId: secondary.connectorId,
        actualConnectorId: primary.connectorId,
      });
      expect((yield* owner.status).connector).toMatchObject({
        connectorId: primary.connectorId,
        queuedCommands: 0,
        pendingCommands: 0,
      });
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("rejects a proof issued by an earlier owner epoch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-epoch-" });
      const port = yield* freePort;
      const store = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", store);
      const replacement = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", store);
      yield* Effect.addFinalizer(() =>
        Effect.all([owner.stop, replacement.stop], { discard: true }),
      );
      yield* owner.start;
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const identity = {
        credential: yield* credentialStore.loadOrCreate,
        protocolFingerprint: yield* nodeProtocolFingerprint,
      } as const;
      const challenge = yield* ownerChallenge(owner.url, identity);
      const headers = ownerProofHeaders(identity, "status", challenge, "");

      yield* owner.stop;
      yield* replacement.start;
      const stale = yield* request(`${replacement.url}${BRIDGE_ROUTES.status.path}`, {
        method: BRIDGE_ROUTES.status.method,
        headers,
      });
      expect(stale.status).toBe(401);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("never resubmits a command after the owner connection is lost", () => {
  let commandPosts = 0;
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-owner-loss-" });
      const fingerprint = yield* nodeProtocolFingerprint;
      const credentialStore = yield* makeBridgeOwnerCredentialStore(agentDir);
      const credential = yield* credentialStore.loadOrCreate;
      const identity = { credential, protocolFingerprint: fingerprint } as const;
      let handshakeSequence = 0;
      const listener = yield* listen((request, response) => {
        if (
          request.method === BRIDGE_ROUTES.ownerHandshake.method &&
          request.url === BRIDGE_ROUTES.ownerHandshake.path
        ) {
          const challenge = {
            bridgeEpoch: "e".repeat(64),
            requestNonce: (handshakeSequence++).toString(16).padStart(64, "0"),
          } as const;
          const clientNonce = String(request.headers[OWNER_CLIENT_NONCE_HEADER] ?? "");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              bridgeDisplayVersion: "0.16.0",
              protocolFingerprint: fingerprint,
              ...challenge,
              proof: ownerServerProof(identity, clientNonce, challenge),
            }),
          );
          return;
        }
        if (
          request.method === BRIDGE_ROUTES.command.method &&
          request.url === BRIDGE_ROUTES.command.path
        ) {
          commandPosts += 1;
          request.socket.destroy();
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false }));
      });
      yield* Effect.addFinalizer(() => close(listener.server));

      const store = yield* makeConnectorBindingStore(agentDir);
      yield* store.save({ ...primary, protocolFingerprint: fingerprint, pairedAt: 1 });
      const client = yield* NodeBridge.make("127.0.0.1", listener.port, () => "0.16.0", store);
      yield* Effect.addFinalizer(() => client.stop);
      yield* client.start;

      const failure = yield* client
        .send(
          { domain: "tab", call: { op: "list" } },
          { key: "session", groupTitle: "Session", foreground: false },
          500,
        )
        .pipe(Effect.flip);
      expect(failure._tag).toBe("CommandOutcomeUnknown");
      expect(commandPosts).toBe(1);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));
});
