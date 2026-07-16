import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { createServer } from "node:http";
import {
  BRIDGE_ROUTES,
  REQUEST_BODY_TOO_LARGE_STATUS,
  requestBodyLimitForRoute,
} from "../../src/protocol/bridge-contract.js";
import { decodePollResponseJson } from "../../src/protocol/codec.js";
import {
  CONNECTOR_DISPLAY_VERSION_METADATA_HEADER,
  CONNECTOR_EXTENSION_ID_HEADER,
  CONNECTOR_PROOF_HEADER,
} from "../../src/protocol/connector-auth.js";
import { CleanupAllResult, FormattedTabResult } from "../../src/protocol/operation-schemas.js";
import type { ProfileConnector, PublicConnector, WebRunOffer } from "../../src/protocol/schema.js";
import { makeConnectorBindingStore } from "../../src/pi/connector-binding.js";
import { EXTENSION_PACKAGE_ID } from "../../src/pi/extension-package.js";
import { NodeBridge } from "../../src/pi/node-bridge.js";
import { nodeProtocolFingerprint } from "../../src/pi/node-protocol-fingerprint.js";
import {
  authenticatedBridgeRequest,
  bridgeRequestProofHeaders,
  issueBridgeChallenge,
  pairingRequest,
} from "./bridge-auth-fixture.js";

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

const request = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(url, { ...init, signal }).then((response) =>
        response.text().then((text) => ({ status: response.status, text })),
      ),
    catch: (cause) => new TestFailure({ message: `request failed: ${url}`, cause }),
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

const packageHeaders = { [CONNECTOR_EXTENSION_ID_HEADER]: EXTENSION_PACKAGE_ID };

const connectorRequest = (
  baseUrl: string,
  routeName: "poll" | "result",
  connector: ProfileConnector,
  body: string = "",
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

const pair = (bridge: NodeBridge, fixture: ConnectorFixture) =>
  Effect.gen(function* () {
    const pairing = yield* bridge.beginPairing();
    const connector = {
      ...fixture,
      protocolFingerprint: pairing.expectedProtocolFingerprint,
    } satisfies ProfileConnector;
    const response = yield* pairingRequest(bridge.url, pairing.challenge, connector);
    expect(response.status).toBe(200);
    return { pairing, connector };
  });

const toPublicConnector = (connector: ProfileConnector): PublicConnector => ({
  connectorId: connector.connectorId,
  label: connector.label,
  extensionId: connector.extensionId,
  extensionDisplayVersion: connector.extensionDisplayVersion,
  protocolFingerprint: connector.protocolFingerprint,
});

const stageWeb = (
  bridge: NodeBridge,
  fixture: ConnectorFixture,
  pairingId: string,
  capability: string,
  sessionKey: string,
) =>
  Effect.gen(function* () {
    const connector = {
      ...fixture,
      protocolFingerprint: yield* nodeProtocolFingerprint,
    } satisfies ProfileConnector;
    const now = yield* Clock.currentTimeMillis;
    const offer = {
      version: 1,
      pairingId,
      capability,
      expiresAt: now + 120_000,
      connector: toPublicConnector(connector),
    } satisfies WebRunOffer;
    const claim = yield* bridge.stageWebRunLease(offer, sessionKey);
    return { connector, offer, claim };
  });

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

const session = {
  key: "session:connector-routing",
  groupTitle: "Pi Session: connector routing",
  foreground: false,
} as const;

const formattedTab = {
  id: 7,
  windowId: 3,
  active: true,
  highlighted: true,
  title: "Node bridge fixture",
  url: "https://example.test/node-bridge",
  groupId: -1,
  group: null,
} satisfies Schema.Schema.Type<typeof FormattedTabResult>;

const cleanupAllResult = {
  closedTabIds: [],
  clearedSessionCount: 0,
  staleOwnershipsCleared: 0,
} satisfies Schema.Schema.Type<typeof CleanupAllResult>;

it.effect("constructs the bridge synchronously at the Pi extension boundary", () =>
  Effect.gen(function* () {
    const store = yield* makeConnectorBindingStore("/tmp/pi-chrome-sync-construction");
    yield* NodeBridge.make("127.0.0.1", 17318, () => "0.16.0", store);
  }),
);

it.live("stops immediately while a connector long-poll is active", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector } = yield* pair(bridge, primary);
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);

      yield* bridge.stop.pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(
              new TestFailure({ message: "bridge stop waited for the connector long-poll" }),
            ),
        }),
      );
      yield* Fiber.await(poll).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () =>
            Effect.fail(new TestFailure({ message: "connector long-poll remained active" })),
        }),
      );
      expect((yield* bridge.status).mode).toBe("closed");
    }),
  ),
);

it.live("delivers commands only to the explicitly paired profile connector", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { pairing, connector: pairedPrimary } = yield* pair(bridge, primary);
      const pairedSecondary = {
        ...secondary,
        protocolFingerprint: pairing.expectedProtocolFingerprint,
      } satisfies ProfileConnector;
      expect(
        (yield* Effect.exit(pairingRequest(bridge.url, pairing.challenge, pairedSecondary)))._tag,
      ).toBe("Failure");
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", pairedPrimary));
      yield* waitUntilConnected(bridge);
      const sender = yield* Effect.forkChild(
        bridge.send({ domain: "tab", call: { op: "list" } }, session, 2_000),
      );
      const polled = yield* Fiber.join(poll);
      expect(polled.status).toBe(200);
      const envelope = yield* decodePollResponseJson(polled.text);
      expect(envelope.type).toBe("command");
      if (envelope.type !== "command") return;

      expect(
        (yield* Effect.exit(
          connectorRequest(
            bridge.url,
            "result",
            pairedSecondary,
            JSON.stringify({ id: envelope.command.id, ok: true, value: "wrong profile" }),
          ),
        ))._tag,
      ).toBe("Failure");

      const invalid = yield* connectorRequest(
        bridge.url,
        "result",
        pairedPrimary,
        JSON.stringify({ id: envelope.command.id, ok: true, value: [{ id: 7 }] }),
      );
      expect(invalid.status).toBe(400);

      const accepted = yield* connectorRequest(
        bridge.url,
        "result",
        pairedPrimary,
        JSON.stringify({ id: envelope.command.id, ok: true, value: [formattedTab] }),
      );
      expect(accepted.status).toBe(200);
      expect(yield* Fiber.join(sender)).toEqual([formattedTab]);

      const status = yield* bridge.status;
      expect(status.binding).toMatchObject({
        connectorId: primary.connectorId,
        label: primary.label,
      });
      expect(JSON.stringify(status)).not.toContain(primary.secret);

      const cleanupPoll = yield* Effect.forkChild(
        connectorRequest(bridge.url, "poll", pairedPrimary),
      );
      const unpair = yield* Effect.forkChild(bridge.unpair(session, 2_000));
      const cleanupEnvelope = yield* Fiber.join(cleanupPoll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(cleanupEnvelope).toMatchObject({
        type: "command",
        command: { domain: "system", call: { op: "cleanup-all" } },
      });
      if (cleanupEnvelope.type !== "command") return;
      const cleanupResult = yield* connectorRequest(
        bridge.url,
        "result",
        pairedPrimary,
        JSON.stringify({
          id: cleanupEnvelope.command.id,
          ok: true,
          value: cleanupAllResult,
        }),
      );
      expect(cleanupResult.status).toBe(200);
      yield* Fiber.join(unpair);
      expect((yield* bridge.status).binding).toBeUndefined();
      expect((yield* Effect.exit(connectorRequest(bridge.url, "poll", pairedPrimary)))._tag).toBe(
        "Failure",
      );
    }),
  ),
);

it.live(
  "routes concurrent web leases by profile and session without changing terminal binding",
  () =>
    withBridge((bridge) =>
      Effect.gen(function* () {
        const { connector: terminalConnector } = yield* pair(bridge, primary);
        const first = yield* stageWeb(
          bridge,
          secondary,
          "33333333-3333-4333-8333-333333333333",
          "C".repeat(32),
          "session:web-one",
        );
        const second = yield* stageWeb(
          bridge,
          primary,
          "44444444-4444-4444-8444-444444444444",
          "D".repeat(32),
          "session:web-two",
        );

        expect(
          (yield* Effect.exit(
            pairingRequest(
              bridge.url,
              first.offer.capability,
              first.connector,
              second.offer.pairingId,
            ),
          ))._tag,
        ).toBe("Failure");

        const wrongProfile = yield* stageWeb(
          bridge,
          secondary,
          "55555555-5555-4555-8555-555555555555",
          "E".repeat(32),
          "session:wrong-profile",
        );
        const rejected = yield* pairingRequest(
          bridge.url,
          wrongProfile.offer.capability,
          terminalConnector,
          wrongProfile.offer.pairingId,
        );
        expect(rejected.status).toBe(409);
        expect((yield* bridge.assertWebRunLease(wrongProfile.claim).pipe(Effect.flip))._tag).toBe(
          "WebConnectorLeaseUnavailable",
        );

        expect(
          (yield* pairingRequest(
            bridge.url,
            first.offer.capability,
            first.connector,
            first.offer.pairingId,
          )).status,
        ).toBe(200);
        expect(
          (yield* pairingRequest(
            bridge.url,
            second.offer.capability,
            second.connector,
            second.offer.pairingId,
          )).status,
        ).toBe(200);
        yield* bridge.assertWebRunLease(first.claim);
        yield* bridge.assertWebRunLease(second.claim);

        const webSession = {
          key: first.claim.sessionKey,
          groupTitle: "Pi Session: web one",
          foreground: false,
        } as const;
        const webPoll = yield* Effect.forkChild(
          connectorRequest(bridge.url, "poll", first.connector),
        );
        const webSender = yield* Effect.forkChild(
          bridge
            .sendWebGuarded(
              first.claim,
              Effect.void,
              { domain: "tab", call: { op: "list" } },
              webSession,
              10_000,
            )
            .pipe(
              Effect.retry({
                times: 100,
                schedule: Schedule.spaced("10 millis"),
                while: (error) => error._tag === "ConnectorOffline",
              }),
            ),
        );
        const webEnvelope = yield* Fiber.join(webPoll).pipe(
          Effect.flatMap((response) => decodePollResponseJson(response.text)),
        );
        expect(webEnvelope).toMatchObject({ type: "command", command: { session: webSession } });
        if (webEnvelope.type !== "command") return;
        expect(
          (yield* connectorRequest(
            bridge.url,
            "result",
            first.connector,
            JSON.stringify({ id: webEnvelope.command.id, ok: true, value: [formattedTab] }),
          )).status,
        ).toBe(200);
        expect(yield* Fiber.join(webSender)).toEqual([formattedTab]);

        const terminalPoll = yield* Effect.forkChild(
          connectorRequest(bridge.url, "poll", terminalConnector),
        );
        const terminalSender = yield* Effect.forkChild(
          bridge.send({ domain: "tab", call: { op: "list" } }, session, 10_000).pipe(
            Effect.retry({
              times: 100,
              schedule: Schedule.spaced("10 millis"),
              while: (error) => error._tag === "ConnectorOffline",
            }),
          ),
        );
        const terminalEnvelope = yield* Fiber.join(terminalPoll).pipe(
          Effect.flatMap((response) => decodePollResponseJson(response.text)),
        );
        expect(terminalEnvelope).toMatchObject({ type: "command", command: { session } });
        if (terminalEnvelope.type !== "command") return;
        expect(
          (yield* connectorRequest(
            bridge.url,
            "result",
            terminalConnector,
            JSON.stringify({ id: terminalEnvelope.command.id, ok: true, value: [formattedTab] }),
          )).status,
        ).toBe(200);
        expect(yield* Fiber.join(terminalSender)).toEqual([formattedTab]);

        yield* bridge.releaseWebRunLease(first.claim);
        expect((yield* bridge.assertWebRunLease(first.claim).pipe(Effect.flip))._tag).toBe(
          "WebConnectorLeaseUnavailable",
        );
        yield* bridge.assertWebRunLease(second.claim);
        expect((yield* bridge.status).binding?.connectorId).toBe(terminalConnector.connectorId);
      }),
    ),
);

it.live("restores a confirmed session connector binding after bridge owner restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-chrome-session-binding-",
      });
      const port = yield* freePort;
      const firstStore = yield* makeConnectorBindingStore(agentDir);
      const firstBridge = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", firstStore);
      yield* Effect.addFinalizer(() => firstBridge.stop);
      yield* firstBridge.start;

      const staged = yield* stageWeb(
        firstBridge,
        secondary,
        "66666666-6666-4666-8666-666666666666",
        "F".repeat(32),
        "session:persisted-web",
      );
      const confirmed = yield* pairingRequest(
        firstBridge.url,
        staged.offer.capability,
        staged.connector,
        staged.offer.pairingId,
      );
      expect(confirmed.status).toBe(200);
      yield* firstBridge.assertWebRunLease(staged.claim);
      yield* firstBridge.stop;

      const secondStore = yield* makeConnectorBindingStore(agentDir);
      const secondBridge = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", secondStore);
      yield* Effect.addFinalizer(() => secondBridge.stop);
      yield* secondBridge.start;

      const restored = (yield* secondBridge.status).sessionRoutes.find(
        ({ sessionKey }) => sessionKey === staged.claim.sessionKey,
      );
      expect(restored?.availability).toBe("live");
      if (restored?.availability !== "live") return;
      expect(restored.claim).toEqual(staged.claim);
      expect(restored?.connector.connectorId).toBe(staged.connector.connectorId);
      expect(restored?.connected).toBe(false);
      yield* secondBridge.assertWebRunLease(staged.claim);
      yield* secondBridge.detachSessionWebRoute(staged.claim.sessionKey, staged.claim.pairingId);
      expect(
        (yield* secondBridge.status).sessionRoutes.some(
          ({ sessionKey }) => sessionKey === staged.claim.sessionKey,
        ),
      ).toBe(false);
      expect((yield* secondBridge.assertWebRunLease(staged.claim).pipe(Effect.flip))._tag).toBe(
        "WebConnectorLeaseUnavailable",
      );
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("revalidates guarded server submissions after lifecycle contention", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector } = yield* pair(bridge, primary);
      const firstPoll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);
      const firstSender = yield* Effect.forkChild(
        bridge.send({ domain: "tab", call: { op: "list" } }, session, 2_000),
      );
      const firstEnvelope = yield* Fiber.join(firstPoll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(firstEnvelope.type).toBe("command");
      if (firstEnvelope.type !== "command") return;

      let authorized = true;
      let admissionChecks = 0;
      const guarded = yield* Effect.forkChild(
        bridge
          .sendGuarded(
            Effect.suspend(() => {
              admissionChecks += 1;
              return authorized
                ? Effect.void
                : Effect.fail(new TestFailure({ message: "authorization was revoked" }));
            }),
            { domain: "tab", call: { op: "list" } },
            session,
            2_000,
          )
          .pipe(Effect.flip),
      );
      yield* Effect.yieldNow;
      expect(admissionChecks).toBe(0);
      authorized = false;

      const firstResult = yield* connectorRequest(
        bridge.url,
        "result",
        connector,
        JSON.stringify({ id: firstEnvelope.command.id, ok: true, value: [formattedTab] }),
      );
      expect(firstResult.status).toBe(200);
      expect(yield* Fiber.join(firstSender)).toEqual([formattedTab]);
      expect(yield* Fiber.join(guarded)).toMatchObject({
        _tag: "TestFailure",
        message: "authorization was revoked",
      });
      expect(admissionChecks).toBe(1);
      expect((yield* bridge.status).connector).toMatchObject({
        queuedCommands: 0,
        pendingCommands: 0,
      });
    }),
  ),
);

it.live("keeps the profile binding when cleanup-all is rejected", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector } = yield* pair(bridge, primary);
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);
      const unpair = yield* Effect.forkChild(bridge.unpair(session, 2_000).pipe(Effect.flip));
      const envelope = yield* Fiber.join(poll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(envelope).toMatchObject({
        type: "command",
        command: { domain: "system", call: { op: "cleanup-all" } },
      });
      if (envelope.type !== "command") return;

      const result = yield* connectorRequest(
        bridge.url,
        "result",
        connector,
        JSON.stringify({
          id: envelope.command.id,
          ok: false,
          error: {
            _tag: "CommandRejected",
            code: "browser-operation",
            message: "profile cleanup failed",
          },
        }),
      );

      expect(result.status).toBe(200);
      expect(yield* Fiber.join(unpair)).toMatchObject({
        _tag: "CommandRejected",
        message: "profile cleanup failed",
      });
      expect((yield* bridge.status).binding?.connectorId).toBe(connector.connectorId);
    }),
  ),
);

it.live("holds new submissions behind unpair and rejects them after the binding is cleared", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector } = yield* pair(bridge, primary);
      const poll = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", connector));
      yield* waitUntilConnected(bridge);
      const unpair = yield* Effect.forkChild(bridge.unpair(session, 2_000));
      const envelope = yield* Fiber.join(poll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(envelope.type).toBe("command");
      if (envelope.type !== "command") return;

      const queuedSubmission = yield* Effect.forkChild(
        bridge.send({ domain: "tab", call: { op: "list" } }, session, 2_000).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: (value) => value,
          }),
        ),
      );
      yield* Effect.yieldNow;
      yield* connectorRequest(
        bridge.url,
        "result",
        connector,
        JSON.stringify({ id: envelope.command.id, ok: true, value: cleanupAllResult }),
      );

      yield* Fiber.join(unpair);
      expect(yield* Fiber.join(queuedSubmission)).toMatchObject({ _tag: "ConnectorNotBound" });
      expect((yield* bridge.status).binding).toBeUndefined();
    }),
  ),
);

it.live("requires explicit unpair before onboarding a different Chrome profile", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector: pairedPrimary } = yield* pair(bridge, primary);
      const replacement = yield* bridge.beginPairing().pipe(Effect.flip);

      expect(replacement).toMatchObject({
        _tag: "PairingUnavailable",
      });
      expect((yield* bridge.status).binding?.connectorId).toBe(pairedPrimary.connectorId);
    }),
  ),
);

it.live("rejects invalid, replayed, and body-tampered connector proofs", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector } = yield* pair(bridge, primary);
      const body = JSON.stringify({ id: "missing-command", ok: true, value: [] });
      const { challenge } = yield* issueBridgeChallenge(
        bridge.url,
        "connectorHandshake",
        "connectorServerProof",
        connector.secret,
        connector,
      );
      const headers = {
        ...bridgeRequestProofHeaders(
          "result",
          "connectorRequestProof",
          connector.secret,
          connector,
          challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const invalid = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: { ...headers, [CONNECTOR_PROOF_HEADER]: "0".repeat(64) },
        body,
      });
      expect(invalid.status).toBe(401);

      const invalidReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers,
        body,
      });
      expect(invalidReplay.status).toBe(401);

      const issuedForIdentity = yield* issueBridgeChallenge(
        bridge.url,
        "connectorHandshake",
        "connectorServerProof",
        connector.secret,
        connector,
      );
      const identityHeaders = bridgeRequestProofHeaders(
        "result",
        "connectorRequestProof",
        connector.secret,
        connector,
        issuedForIdentity.challenge,
        body,
      );
      const tamperedIdentity = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: {
          ...identityHeaders,
          [CONNECTOR_DISPLAY_VERSION_METADATA_HEADER]: "99.0.0",
          "content-type": "application/json",
        },
        body,
      });
      expect(tamperedIdentity.status).toBe(401);

      const fresh = yield* issueBridgeChallenge(
        bridge.url,
        "connectorHandshake",
        "connectorServerProof",
        connector.secret,
        connector,
      );
      const freshHeaders = {
        ...bridgeRequestProofHeaders(
          "result",
          "connectorRequestProof",
          connector.secret,
          connector,
          fresh.challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const admitted = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: freshHeaders,
        body,
      });
      expect(admitted.status).toBe(404);
      const replay = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: freshHeaders,
        body,
      });
      expect(replay.status).toBe(401);

      const issuedForBody = yield* issueBridgeChallenge(
        bridge.url,
        "connectorHandshake",
        "connectorServerProof",
        connector.secret,
        connector,
      );
      const bodyHeaders = {
        ...bridgeRequestProofHeaders(
          "result",
          "connectorRequestProof",
          connector.secret,
          connector,
          issuedForBody.challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const tampered = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: bodyHeaders,
        body: `${body} `,
      });
      expect(tampered.status).toBe(401);
      const bodyReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.result.path}`, {
        method: BRIDGE_ROUTES.result.method,
        headers: bodyHeaders,
        body,
      });
      expect(bodyReplay.status).toBe(401);
    }),
  ),
);

it.live("consumes pairing challenges after body or path tampering", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const pairing = yield* bridge.beginPairing();
      const connector = {
        ...primary,
        protocolFingerprint: pairing.expectedProtocolFingerprint,
      } satisfies ProfileConnector;
      const body = JSON.stringify({ connector });

      const issuedForBody = yield* issueBridgeChallenge(
        bridge.url,
        "pairingHandshake",
        "pairingServerProof",
        pairing.challenge,
        connector,
      );
      const bodyHeaders = {
        ...bridgeRequestProofHeaders(
          "pairingConfirm",
          "pairingRequestProof",
          pairing.challenge,
          connector,
          issuedForBody.challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const tamperedBody = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: bodyHeaders,
        body: `${body} `,
      });
      expect(tamperedBody.status).toBe(401);
      const bodyReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: bodyHeaders,
        body,
      });
      expect(bodyReplay.status).toBe(401);

      const issuedForPath = yield* issueBridgeChallenge(
        bridge.url,
        "pairingHandshake",
        "pairingServerProof",
        pairing.challenge,
        connector,
      );
      const wrongPathHeaders = {
        ...bridgeRequestProofHeaders(
          "result",
          "pairingRequestProof",
          pairing.challenge,
          connector,
          issuedForPath.challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const tamperedPath = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: wrongPathHeaders,
        body,
      });
      expect(tamperedPath.status).toBe(401);
      const correctPathHeaders = {
        ...bridgeRequestProofHeaders(
          "pairingConfirm",
          "pairingRequestProof",
          pairing.challenge,
          connector,
          issuedForPath.challenge,
          body,
        ),
        "content-type": "application/json",
      };
      const pathReplay = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: correctPathHeaders,
        body,
      });
      expect(pathReplay.status).toBe(401);

      for (const response of [tamperedBody, bodyReplay, tamperedPath, pathReplay]) {
        expect(response.text).not.toContain(pairing.challenge);
        expect(response.text).not.toContain(connector.secret);
      }
      expect((yield* bridge.status).binding).toBeUndefined();
      expect((yield* pairingRequest(bridge.url, pairing.challenge, connector)).status).toBe(200);
    }),
  ),
);

it.live("fails closed before pairing and rejects a different extension package origin", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.exit(bridge.send({ domain: "tab", call: { op: "list" } }, session, 100)))
          ._tag,
      ).toBe("Failure");

      const pairing = yield* bridge.beginPairing();
      const connector = {
        ...primary,
        protocolFingerprint: pairing.expectedProtocolFingerprint,
      } satisfies ProfileConnector;
      const rejected = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: {
          ...packageHeaders,
          origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "content-type": "application/json",
        },
        body: JSON.stringify({ connector }),
      });
      expect(rejected.status).toBe(403);
      expect((yield* bridge.status).binding).toBeUndefined();
    }),
  ),
);

it.live("rejects an oversized request body with 413 before decoding", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const pairing = yield* bridge.beginPairing();
      const connector = {
        ...primary,
        protocolFingerprint: pairing.expectedProtocolFingerprint,
      } satisfies ProfileConnector;
      const { challenge } = yield* issueBridgeChallenge(
        bridge.url,
        "pairingHandshake",
        "pairingServerProof",
        pairing.challenge,
        connector,
      );
      const limit = requestBodyLimitForRoute("pairingConfirm");
      const oversized = "x".repeat(limit + 1);
      const response = yield* request(`${bridge.url}${BRIDGE_ROUTES.pairingConfirm.path}`, {
        method: BRIDGE_ROUTES.pairingConfirm.method,
        headers: {
          ...bridgeRequestProofHeaders(
            "pairingConfirm",
            "pairingRequestProof",
            pairing.challenge,
            connector,
            challenge,
            oversized,
          ),
          "content-type": "application/json",
        },
        body: oversized,
      });
      expect(response.status).toBe(REQUEST_BODY_TOO_LARGE_STATUS);
      expect(response.text).toContain(`exceeds ${limit} bytes`);
    }),
  ),
);

it.live("rejects a mismatched protocol without consuming the pairing capability", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const pairing = yield* bridge.beginPairing();

      const exposed = yield* request(`${bridge.url}/pairing`, {
        headers: {
          ...packageHeaders,
          origin: `chrome-extension://${EXTENSION_PACKAGE_ID}`,
        },
      });
      expect(exposed.status).toBe(404);
      expect(exposed.text).not.toContain(pairing.challenge);

      const connector = {
        ...primary,
        protocolFingerprint: pairing.expectedProtocolFingerprint,
      } satisfies ProfileConnector;
      const wrongProtocol = yield* pairingRequest(bridge.url, pairing.challenge, {
        ...connector,
        protocolFingerprint: "f".repeat(64),
      });
      expect(wrongProtocol.status).toBe(409);

      const accepted = yield* pairingRequest(bridge.url, pairing.challenge, {
        ...connector,
        extensionDisplayVersion: "0.15.0",
      });
      expect(accepted.status).toBe(200);

      expect((yield* bridge.beginPairing().pipe(Effect.flip))._tag).toBe("PairingUnavailable");
      const pairedConnector = { ...connector, extensionDisplayVersion: "0.15.0" };
      const cleanupPoll = yield* Effect.forkChild(
        connectorRequest(bridge.url, "poll", pairedConnector),
      );
      yield* waitUntilConnected(bridge);
      const unpair = yield* Effect.forkChild(bridge.unpair(session, 2_000));
      const cleanupEnvelope = yield* Fiber.join(cleanupPoll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(cleanupEnvelope.type).toBe("command");
      if (cleanupEnvelope.type !== "command") return;
      yield* connectorRequest(
        bridge.url,
        "result",
        pairedConnector,
        JSON.stringify({
          id: cleanupEnvelope.command.id,
          ok: true,
          value: cleanupAllResult,
        }),
      );
      yield* Fiber.join(unpair);

      const cancelled = yield* bridge.beginPairing();
      yield* bridge.unpair(session, 2_000);
      expect(
        (yield* Effect.exit(pairingRequest(bridge.url, cancelled.challenge, connector)))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.live("reports an incompatible poll without dequeueing or accepting its result", () =>
  withBridge((bridge) =>
    Effect.gen(function* () {
      const { connector: pairedPrimary } = yield* pair(bridge, primary);
      const warmup = yield* Effect.forkChild(connectorRequest(bridge.url, "poll", pairedPrimary));
      yield* waitUntilConnected(bridge);
      yield* Fiber.interrupt(warmup);

      const sender = yield* Effect.forkChild(
        bridge.send({ domain: "tab", call: { op: "list" } }, session, 2_000),
      );
      const wrongProtocolConnector = {
        ...pairedPrimary,
        extensionDisplayVersion: "0.15.0",
        protocolFingerprint: "f".repeat(64),
      };
      const incompatible = yield* connectorRequest(bridge.url, "poll", wrongProtocolConnector);
      expect(incompatible.status).toBe(200);
      expect(yield* decodePollResponseJson(incompatible.text)).toEqual({
        type: "incompatible",
        expectedExtensionDisplayVersion: "0.16.0",
        actualExtensionDisplayVersion: "0.15.0",
        expectedProtocolFingerprint: pairedPrimary.protocolFingerprint,
        actualProtocolFingerprint: "f".repeat(64),
      });
      expect((yield* bridge.status).protocolCompatibility).toEqual({
        compatible: false,
        extensionId: pairedPrimary.extensionId,
        expectedExtensionDisplayVersion: "0.16.0",
        actualExtensionDisplayVersion: "0.15.0",
      });

      const differentDisplayVersionConnector = {
        ...pairedPrimary,
        extensionDisplayVersion: "0.15.0",
      };
      const polled = yield* connectorRequest(bridge.url, "poll", differentDisplayVersionConnector);
      expect((yield* bridge.status).protocolCompatibility).toEqual({
        compatible: true,
        expectedExtensionDisplayVersion: "0.16.0",
      });
      const envelope = yield* decodePollResponseJson(polled.text);
      expect(envelope.type).toBe("command");
      if (envelope.type !== "command") return;
      const result = yield* connectorRequest(
        bridge.url,
        "result",
        wrongProtocolConnector,
        JSON.stringify({ id: envelope.command.id, ok: true, value: [] }),
      );
      expect(result.status).toBe(404);

      const accepted = yield* connectorRequest(
        bridge.url,
        "result",
        pairedPrimary,
        JSON.stringify({ id: envelope.command.id, ok: true, value: [] }),
      );
      expect(accepted.status).toBe(200);
      expect(yield* Fiber.join(sender)).toEqual([]);
    }),
  ),
);

it.live("routes client unpair through one owner-side cleanup-and-clear transaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-client-unpair-" });
      const port = yield* freePort;
      const ownerStore = yield* makeConnectorBindingStore(agentDir);
      const clientStore = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));
      yield* owner.start;
      yield* client.start;
      const { connector } = yield* pair(owner, primary);
      const poll = yield* Effect.forkChild(connectorRequest(owner.url, "poll", connector));
      yield* waitUntilConnected(owner);

      const unpair = yield* Effect.forkChild(client.unpair(session, 2_000));
      const envelope = yield* Fiber.join(poll).pipe(
        Effect.flatMap((response) => decodePollResponseJson(response.text)),
      );
      expect(envelope).toMatchObject({
        type: "command",
        command: { domain: "system", call: { op: "cleanup-all" } },
      });
      if (envelope.type !== "command") return;
      yield* connectorRequest(
        owner.url,
        "result",
        connector,
        JSON.stringify({ id: envelope.command.id, ok: true, value: cleanupAllResult }),
      );

      yield* Fiber.join(unpair);
      expect((yield* owner.status).binding).toBeUndefined();
      expect((yield* client.status).binding).toBeUndefined();
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("recovers explicitly when the bound connector identity is permanently lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-client-forget-" });
      const port = yield* freePort;
      const ownerStore = yield* makeConnectorBindingStore(agentDir);
      const clientStore = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));
      yield* owner.start;
      yield* client.start;

      const { connector: lost } = yield* pair(owner, primary);
      const unpairFailure = yield* client.unpair(session, 2_000).pipe(Effect.flip);
      expect(unpairFailure).toMatchObject({
        _tag: "ConnectorOffline",
        connectorId: lost.connectorId,
      });
      expect((yield* owner.status).binding?.connectorId).toBe(lost.connectorId);

      yield* client.forget(lost.connectorId);
      expect((yield* owner.status).binding).toBeUndefined();
      expect((yield* client.status).binding).toBeUndefined();

      const { connector: replacement } = yield* pair(owner, secondary);
      expect((yield* owner.status).binding?.connectorId).toBe(replacement.connectorId);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);

it.live("reloads the persisted connector when a client takes bridge ownership", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-takeover-" });
      const port = yield* freePort;
      const ownerStore = yield* makeConnectorBindingStore(agentDir);
      const clientStore = yield* makeConnectorBindingStore(agentDir);
      const owner = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", ownerStore);
      const client = yield* NodeBridge.make("127.0.0.1", port, () => "0.16.0", clientStore);
      yield* Effect.addFinalizer(() => Effect.all([owner.stop, client.stop], { discard: true }));

      yield* owner.start;
      yield* client.start;
      expect((yield* owner.status).mode).toBe("server");
      expect((yield* client.status).mode).toBe("client");
      yield* pair(owner, primary);

      yield* owner.stop;
      const promoted = yield* client.status;
      expect(promoted.mode).toBe("server");
      expect(promoted.binding?.connectorId).toBe(primary.connectorId);
    }),
  ).pipe(Effect.provide(nodeServicesLayer)),
);
