import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  BRIDGE_ORIGIN,
  MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
} from "../../src/protocol/bridge-contract.js";
import { decodeBridgeStatusJson } from "../../src/protocol/codec.js";

const connector = {
  connectorId: "11111111-1111-4111-8111-111111111111",
  label: "Personal Chrome",
  extensionId: "a".repeat(32),
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "b".repeat(64),
  connected: true,
  lastSeenAt: 1,
  queuedCommands: 0,
  pendingCommands: 0,
} as const;

const bridge = {
  url: BRIDGE_ORIGIN,
  mode: "server",
  extensionExpectation: {
    extensionId: "a".repeat(32),
    displayVersion: "1.0.0",
    protocolFingerprint: "b".repeat(64),
  },
} as const;

const decode = (value: unknown) => decodeBridgeStatusJson(JSON.stringify(value));

it.effect("accepts waiting and active connector states without binding projections", () =>
  Effect.gen(function* () {
    expect(yield* decode(bridge)).toMatchObject({ mode: "server" });
    expect(yield* decode({ ...bridge, connector })).toMatchObject({ connector });
  }),
);

it.effect("bounds live connector admission counts and display versions", () =>
  Effect.gen(function* () {
    const overCapacity = {
      ...bridge,
      connector: {
        ...connector,
        queuedCommands: MAX_ADMITTED_COMMANDS_PER_CONNECTOR,
        pendingCommands: 1,
      },
    };
    const oversizedVersion = {
      ...bridge,
      connector: { ...connector, extensionDisplayVersion: "x".repeat(65) },
    };

    expect((yield* Effect.exit(decode(overCapacity)))._tag).toBe("Failure");
    expect((yield* Effect.exit(decode(oversizedVersion)))._tag).toBe("Failure");
  }),
);
