import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CONNECTOR_STORAGE_KEY } from "../../src/protocol/connector-auth.js";
import { ConnectorIdentityOwner } from "../../src/browser/connector-identity.js";

const storage: Record<string, unknown> = {};
let getCalls = 0;
let setCalls = 0;
let manifestVersion = "0.16.0";

const resolved = <A>(value: A): Promise<A> =>
  new Promise((resolve) => {
    resolve(value);
  });

const chromeMock = {
  runtime: {
    id: "a".repeat(32),
    getManifest: () => ({ version: manifestVersion }),
  },
  storage: {
    local: {
      get: (key: string) => {
        getCalls += 1;
        return resolved(key in storage ? { [key]: storage[key] } : {});
      },
      set: (value: Record<string, unknown>) => {
        setCalls += 1;
        return resolved(Object.assign(storage, value));
      },
    },
  },
};

Object.assign(globalThis, { chrome: chromeMock });

const clearStorage = Effect.sync(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  getCalls = 0;
  setCalls = 0;
  manifestVersion = "0.16.0";
});

it.effect("keeps one profile connector identity across MV3 worker restarts", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const first = yield* ConnectorIdentityOwner.makeUnsafe().load;
    const afterRestart = yield* ConnectorIdentityOwner.makeUnsafe().load;

    expect(afterRestart).toEqual(first);
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(storage[CONNECTOR_STORAGE_KEY]).toEqual({
      connectorId: first.connectorId,
      secret: first.secret,
      label: first.label,
    });
  }),
);

it.effect("gives profiles distinct connectors under the same extension package id", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const firstProfile = yield* ConnectorIdentityOwner.makeUnsafe().load;
    yield* clearStorage;
    const secondProfile = yield* ConnectorIdentityOwner.makeUnsafe().load;

    expect(firstProfile.extensionId).toBe(secondProfile.extensionId);
    expect(firstProfile.connectorId).not.toBe(secondProfile.connectorId);
    expect(firstProfile.secret).not.toBe(secondProfile.secret);
  }),
);

it.effect("fails closed instead of replacing corrupt persisted identity", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    storage[CONNECTOR_STORAGE_KEY] = { connectorId: "incomplete" };

    expect((yield* Effect.exit(ConnectorIdentityOwner.makeUnsafe().load))._tag).toBe("Failure");
    expect(storage[CONNECTOR_STORAGE_KEY]).toEqual({ connectorId: "incomplete" });
  }),
);

it.effect("rejects the old runtime-projection storage shape", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const projected = yield* ConnectorIdentityOwner.makeUnsafe().load;
    storage[CONNECTOR_STORAGE_KEY] = projected;

    expect((yield* Effect.exit(ConnectorIdentityOwner.makeUnsafe().load))._tag).toBe("Failure");
    expect(storage[CONNECTOR_STORAGE_KEY]).toEqual(projected);
  }),
);

it.effect("creates one identity for concurrent first loads", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const owner = ConnectorIdentityOwner.makeUnsafe();
    const connectors = yield* Effect.all(
      Array.from({ length: 20 }, () => owner.load),
      {
        concurrency: "unbounded",
      },
    );

    expect(new Set(connectors.map(({ connectorId }) => connectorId)).size).toBe(1);
    expect(getCalls).toBe(1);
    expect(setCalls).toBe(1);
  }),
);

it.effect("ignores the pre-hard-cut identity storage key", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const legacy = {
      connectorId: "legacy-connector",
      secret: "0".repeat(64),
      label: "Legacy Chrome",
    };
    storage.piChromeProfileConnector = legacy;

    const connector = yield* ConnectorIdentityOwner.makeUnsafe().load;

    expect(connector.connectorId).not.toBe(legacy.connectorId);
    expect(storage.piChromeProfileConnector).toEqual(legacy);
    expect(storage[CONNECTOR_STORAGE_KEY]).toEqual({
      connectorId: connector.connectorId,
      secret: connector.secret,
      label: connector.label,
    });
  }),
);

it.effect("projects live display metadata without rewriting persisted identity", () =>
  Effect.gen(function* () {
    yield* clearStorage;
    const owner = ConnectorIdentityOwner.makeUnsafe();
    const first = yield* owner.load;
    const persisted = storage[CONNECTOR_STORAGE_KEY];

    manifestVersion = "0.17.0";
    const second = yield* owner.load;

    expect(first.extensionDisplayVersion).toBe("0.16.0");
    expect(second.extensionDisplayVersion).toBe("0.17.0");
    expect(second.connectorId).toBe(first.connectorId);
    expect(storage[CONNECTOR_STORAGE_KEY]).toBe(persisted);
    expect(setCalls).toBe(1);
  }),
);
