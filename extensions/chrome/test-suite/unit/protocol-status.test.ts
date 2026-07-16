import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BRIDGE_ORIGIN,
  MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
} from "../../src/protocol/bridge-contract.js";
import { decodeBridgeStatusJson } from "../../src/protocol/codec.js";

const connectorId = "11111111-1111-4111-8111-111111111111";
const publicConnector = {
  connectorId,
  label: "Personal Chrome",
  extensionId: "a".repeat(32),
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "b".repeat(64),
} as const;
const binding = { ...publicConnector, pairedAt: 1 } as const;
const seenConnector = {
  ...publicConnector,
  connected: true,
  lastSeenAt: 1,
  queuedCommands: 0,
  pendingCommands: 0,
} as const;
const bridge = {
  url: BRIDGE_ORIGIN,
  mode: "server",
  sessionRoutes: [],
  extensionExpectation: {
    extensionId: "a".repeat(32),
    displayVersion: "1.0.0",
    protocolFingerprint: "b".repeat(64),
  },
} as const;

const decode = (value: unknown) => decodeBridgeStatusJson(JSON.stringify(value));

it.effect("accepts only complete unbound or bound bridge status states", () =>
  Effect.gen(function* () {
    expect(yield* decode(bridge)).toMatchObject({
      mode: "server",
    });
    expect(
      yield* decode({
        ...bridge,
        binding,
        connector: seenConnector,
      }),
    ).toMatchObject({ binding, connector: seenConnector });

    for (const impossible of [
      { ...bridge, binding },
      { ...bridge, connector: seenConnector },
      {
        ...bridge,
        binding,
        connector: {
          connectorId,
          connected: true,
          queuedCommands: 0,
          pendingCommands: 0,
        },
      },
      {
        ...bridge,
        binding,
        connector: {
          connectorId,
          connected: false,
          extensionDisplayVersion: "1.0.0",
          queuedCommands: 0,
          pendingCommands: 0,
        },
      },
      {
        ...bridge,
        binding,
        connector: { ...seenConnector, connectorId: "22222222-2222-4222-8222-222222222222" },
      },
      {
        ...bridge,
        binding,
        connector: {
          connectorId,
          connected: false,
          queuedCommands: 1,
          pendingCommands: 0,
        },
      },
    ]) {
      expect((yield* Effect.exit(decode(impossible)))._tag).toBe("Failure");
    }
  }),
);

it.effect("rejects a live session route whose claim crosses route ownership", () =>
  Effect.gen(function* () {
    const route = {
      source: "web",
      sessionKey: "session:one",
      generation: "22222222-2222-4222-8222-222222222222",
      availability: "live",
      claim: {
        pairingId: "22222222-2222-4222-8222-222222222222",
        leaseToken: "c".repeat(64),
        connectorId,
        sessionKey: "session:other",
      },
      connector: publicConnector,
      expiresAt: 10_000,
      connected: true,
    } as const;

    const failure = yield* decode({ ...bridge, sessionRoutes: [route] }).pipe(Effect.flip);
    expect(failure.message).toContain("Invalid bridge status");
  }),
);

it.effect("bounds connector status admission counts and display versions", () =>
  Effect.gen(function* () {
    const overCapacity = {
      ...bridge,
      binding,
      connector: {
        ...seenConnector,
        queuedCommands: MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
        pendingCommands: 1,
      },
    };
    const oversizedVersion = {
      ...bridge,
      binding: { ...binding, extensionDisplayVersion: "x".repeat(65) },
      connector: seenConnector,
    };

    expect((yield* Effect.exit(decode(overCapacity)))._tag).toBe("Failure");
    expect((yield* Effect.exit(decode(oversizedVersion)))._tag).toBe("Failure");
  }),
);
