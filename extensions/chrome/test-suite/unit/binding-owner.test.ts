import { expect, it } from "@effect/vitest";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { CommandBroker } from "../../src/core/broker.js";
import { WEB_RUN_LEASE_LIFETIME_MS } from "../../src/protocol/bridge-contract.js";
import type {
  BoundConnector,
  PublicConnector,
  WebRunLeaseClaim,
} from "../../src/protocol/schema.js";
import { ConnectorOwner, type BindingPersistence } from "../../src/pi/connector-owner.js";
import type {
  PersistedSessionConnectorBinding,
  SessionConnectorBindingPersistence,
} from "../../src/pi/session-connector-binding.js";

const primary = {
  connectorId: "connector-primary",
  secret: "a".repeat(64),
  label: "Personal Chrome",
  extensionId: "extension-package",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
  pairedAt: 1,
} satisfies BoundConnector;

const secondary = {
  connectorId: "connector-secondary",
  secret: "b".repeat(64),
  label: "Work Chrome",
  extensionId: "extension-package",
  extensionDisplayVersion: "1.0.0",
  protocolFingerprint: "a".repeat(64),
  pairedAt: 2,
} satisfies BoundConnector;

const publicConnector = (binding: BoundConnector): PublicConnector => ({
  connectorId: binding.connectorId,
  label: binding.label,
  extensionId: binding.extensionId,
  extensionDisplayVersion: binding.extensionDisplayVersion,
  protocolFingerprint: binding.protocolFingerprint,
});

it.effect("linearizes reload, replace, and clear around persistence commit", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(primary);
    const loadEntered = yield* Deferred.make<void>();
    const releaseLoad = yield* Deferred.make<void>();
    const saveEntered = yield* Deferred.make<void>();
    const commitSave = yield* Deferred.make<void>();
    const saveCommitted = yield* Deferred.make<void>();
    const returnSave = yield* Deferred.make<void>();
    const clearEntered = yield* Deferred.make<void>();
    const commitClear = yield* Deferred.make<void>();
    const clearCommitted = yield* Deferred.make<void>();
    const returnClear = yield* Deferred.make<void>();
    const persistence: BindingPersistence = {
      load: Effect.gen(function* () {
        yield* Deferred.succeed(loadEntered, undefined);
        yield* Deferred.await(releaseLoad);
        return yield* Ref.get(stored);
      }),
      save: (binding) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(saveEntered, undefined);
          yield* Deferred.await(commitSave);
          yield* Ref.set(stored, binding);
          yield* Deferred.succeed(saveCommitted, undefined);
          yield* Deferred.await(returnSave);
        }),
      clear: Effect.gen(function* () {
        yield* Deferred.succeed(clearEntered, undefined);
        yield* Deferred.await(commitClear);
        yield* Ref.set(stored, undefined);
        yield* Deferred.succeed(clearCommitted, undefined);
        yield* Deferred.await(returnClear);
      }),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);

    const reload = yield* Effect.forkChild(owner.reload);
    yield* Deferred.await(loadEntered);
    const replace = yield* Effect.forkChild(owner.replace(secondary));
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(saveEntered))).toBe(true);
    expect(yield* owner.current).toBeUndefined();

    yield* Deferred.succeed(releaseLoad, undefined);
    yield* Fiber.join(reload);
    yield* Deferred.await(saveEntered);
    expect(yield* owner.current).toEqual(primary);

    const clear = yield* Effect.forkChild(owner.clear);
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(clearEntered))).toBe(true);

    yield* Deferred.succeed(commitSave, undefined);
    yield* Deferred.await(saveCommitted);
    expect(yield* Ref.get(stored)).toEqual(secondary);
    expect(yield* owner.current).toEqual(primary);
    expect(Option.isNone(yield* Deferred.poll(clearEntered))).toBe(true);

    yield* Deferred.succeed(returnSave, undefined);
    yield* Fiber.join(replace);
    yield* Deferred.await(clearEntered);
    expect(yield* owner.current).toEqual(secondary);
    expect(yield* broker.next(publicConnector(primary), 60_000)).toBeUndefined();

    yield* Deferred.succeed(commitClear, undefined);
    yield* Deferred.await(clearCommitted);
    expect(yield* Ref.get(stored)).toBeUndefined();
    expect(yield* owner.current).toEqual(secondary);

    yield* Deferred.succeed(returnClear, undefined);
    yield* Fiber.join(clear);
    expect(yield* owner.current).toBeUndefined();
    expect(yield* Ref.get(stored)).toBeUndefined();
    expect(yield* broker.next(publicConnector(secondary), 60_000)).toBeUndefined();
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("publishes a committed replacement despite interruption", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(primary);
    const saveEntered = yield* Deferred.make<void>();
    const releaseSave = yield* Deferred.make<void>();
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(saveEntered, undefined);
          yield* Deferred.await(releaseSave);
          yield* Ref.set(stored, binding);
        }),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    yield* owner.reload;

    const replace = yield* Effect.forkChild(owner.replace(secondary));
    yield* Deferred.await(saveEntered);
    const interrupt = yield* Effect.forkChild(Fiber.interrupt(replace));
    yield* Effect.yieldNow;
    expect(yield* owner.current).toEqual(primary);

    yield* Deferred.succeed(releaseSave, undefined);
    yield* Fiber.join(interrupt);
    expect(yield* owner.current).toEqual(secondary);
    expect(yield* Ref.get(stored)).toEqual(secondary);
    expect(yield* broker.next(publicConnector(primary), 60_000)).toBeUndefined();
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("owns exact bound, mismatched, and absent connector states", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(undefined);
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) => Ref.set(stored, binding),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    yield* owner.reload;

    expect((yield* owner.requireBoundConnector.pipe(Effect.flip))._tag).toBe("ConnectorNotBound");
    expect((yield* owner.expectBoundConnector(primary.connectorId).pipe(Effect.flip))._tag).toBe(
      "ConnectorNotBound",
    );
    yield* owner.expectNoConnector;

    yield* owner.replace(primary);
    expect((yield* owner.requireBoundConnector).connectorId).toBe(primary.connectorId);
    expect((yield* owner.expectBoundConnector(primary.connectorId)).connectorId).toBe(
      primary.connectorId,
    );
    expect((yield* owner.expectBoundConnector(secondary.connectorId).pipe(Effect.flip))._tag).toBe(
      "ConnectorBindingMismatch",
    );
    expect((yield* owner.expectNoConnector.pipe(Effect.flip))._tag).toBe("ConnectorAlreadyBound");
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect(
  "projects durable binding and live session routes into one authorized connector set",
  () =>
    Effect.gen(function* () {
      const stored = yield* Ref.make<BoundConnector | undefined>(primary);
      const persistence: BindingPersistence = {
        load: Ref.get(stored),
        save: (binding) => Ref.set(stored, binding),
        clear: Ref.set(stored, undefined),
      };
      const broker = yield* CommandBroker.make;
      const owner = yield* ConnectorOwner.make(persistence, broker);
      yield* owner.reload;
      const claim = {
        pairingId: "11111111-1111-4111-8111-111111111111",
        leaseToken: "c".repeat(64),
        connectorId: secondary.connectorId,
        sessionKey: "session:web",
      } satisfies WebRunLeaseClaim;

      yield* owner.registerWebLease(claim, secondary);
      expect(yield* owner.hasWebLease(claim)).toBe(true);
      expect((yield* owner.authorizedConnector(primary.connectorId))?.secret).toBe(primary.secret);
      expect((yield* owner.authorizedConnector(secondary.connectorId))?.secret).toBe(
        secondary.secret,
      );
      expect(
        (yield* owner.sessionRouteStatuses).map(({ connector }) => connector.connectorId),
      ).toEqual([secondary.connectorId]);

      yield* owner.releaseWebLease(claim);
      expect(yield* owner.hasWebLease(claim)).toBe(false);
      expect(yield* owner.authorizedConnector(secondary.connectorId)).toBeUndefined();
      expect((yield* owner.requireBoundConnector).connectorId).toBe(primary.connectorId);
      yield* broker.stop;
    }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("keeps interleaved live connector evidence scoped to its session route", () =>
  Effect.gen(function* () {
    const persistence: BindingPersistence = {
      load: Effect.sync(() => undefined),
      save: () => Effect.sync(() => undefined),
      clear: Effect.sync(() => undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    yield* owner.reload;
    const firstClaim = {
      pairingId: "11111111-1111-4111-8111-111111111111",
      leaseToken: "c".repeat(64),
      connectorId: primary.connectorId,
      sessionKey: "session:first",
    } satisfies WebRunLeaseClaim;
    const secondClaim = {
      pairingId: "22222222-2222-4222-8222-222222222222",
      leaseToken: "d".repeat(64),
      connectorId: secondary.connectorId,
      sessionKey: "session:second",
    } satisfies WebRunLeaseClaim;
    yield* owner.registerWebLease(firstClaim, primary);
    yield* owner.registerWebLease(secondClaim, secondary);

    const firstObserved = { ...publicConnector(primary), extensionDisplayVersion: "1.1.0" };
    const secondObserved = {
      ...publicConnector(secondary),
      extensionDisplayVersion: "0.9.0",
      protocolFingerprint: "f".repeat(64),
    };
    yield* broker.next(firstObserved, 0);
    yield* broker.next(secondObserved, 0);
    yield* broker.next(firstObserved, 0);

    const bySession = new Map(
      (yield* owner.sessionRouteStatuses).map((route) => [route.sessionKey, route.connector]),
    );
    expect(bySession.get(firstClaim.sessionKey)).toEqual(firstObserved);
    expect(bySession.get(secondClaim.sessionKey)).toEqual(secondObserved);
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("refreshes a durable binding from the current projection of the same connector", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(primary);
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) => Ref.set(stored, binding),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    yield* owner.reload;
    const upgraded = {
      ...primary,
      label: "Renamed Personal Chrome",
      extensionDisplayVersion: "2.0.0",
      protocolFingerprint: "c".repeat(64),
    };
    const claim = {
      pairingId: "22222222-2222-4222-8222-222222222222",
      leaseToken: "d".repeat(64),
      connectorId: primary.connectorId,
      sessionKey: "session:upgraded-web",
    } satisfies WebRunLeaseClaim;

    yield* owner.registerWebLease(claim, upgraded);

    expect(yield* owner.requireBoundConnector).toEqual(upgraded);
    expect(yield* Ref.get(stored)).toEqual(upgraded);
    expect(yield* owner.useWebLease(claim, Effect.succeed)).toEqual(upgraded);
    yield* owner.releaseWebLease(claim);
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("rejects reused connector ids with different stable authority", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(primary);
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) => Ref.set(stored, binding),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    yield* owner.reload;
    const claim = {
      pairingId: "22222222-2222-4222-8222-222222222222",
      leaseToken: "d".repeat(64),
      connectorId: primary.connectorId,
      sessionKey: "session:conflicting-web",
    } satisfies WebRunLeaseClaim;

    const failure = yield* owner
      .registerWebLease(claim, { ...primary, secret: "e".repeat(64) })
      .pipe(Effect.flip);

    expect(failure._tag).toBe("ConnectorBindingMismatch");
    expect(yield* Ref.get(stored)).toEqual(primary);
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("linearizes web lease release after an admitted lease use", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(undefined);
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) => Ref.set(stored, binding),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    const claim = {
      pairingId: "11111111-1111-4111-8111-111111111111",
      leaseToken: "c".repeat(64),
      connectorId: secondary.connectorId,
      sessionKey: "session:web",
    } satisfies WebRunLeaseClaim;
    yield* owner.registerWebLease(claim, secondary);
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const use = yield* Effect.forkChild(
      owner.useWebLease(claim, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ),
    );
    yield* Deferred.await(entered);
    const releaseCompleted = yield* Deferred.make<void>();
    const release = yield* Effect.forkChild(
      owner
        .releaseWebLease(claim)
        .pipe(Effect.ensuring(Deferred.succeed(releaseCompleted, undefined))),
    );
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(releaseCompleted))).toBe(true);

    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(use);
    yield* Fiber.join(release);
    expect(yield* owner.hasWebLease(claim)).toBe(false);
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("keeps an expired session route while removing its live connector authority", () =>
  Effect.gen(function* () {
    const binding = yield* Ref.make<BoundConnector | undefined>(undefined);
    const routes = yield* Ref.make<ReadonlyArray<PersistedSessionConnectorBinding>>([]);
    const persistence: BindingPersistence = {
      load: Ref.get(binding),
      save: (next) => Ref.set(binding, next),
      clear: Ref.set(binding, undefined),
    };
    const routePersistence: SessionConnectorBindingPersistence = {
      load: Ref.get(routes),
      save: (next) => Ref.set(routes, next),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker, routePersistence);
    const claim = {
      pairingId: "33333333-3333-4333-8333-333333333333",
      leaseToken: "f".repeat(64),
      connectorId: secondary.connectorId,
      sessionKey: "session:expiring-web",
    } satisfies WebRunLeaseClaim;

    yield* owner.registerWebLease(claim, secondary);
    expect((yield* owner.sessionRouteStatuses)[0]?.availability).toBe("live");

    yield* TestClock.adjust(`${WEB_RUN_LEASE_LIFETIME_MS + 1} millis`);

    const expired = (yield* owner.sessionRouteStatuses)[0];
    expect(expired).toMatchObject({
      sessionKey: claim.sessionKey,
      generation: claim.pairingId,
      availability: "expired",
      connected: false,
    });
    expect(yield* owner.hasWebLease(claim)).toBe(false);
    expect(yield* owner.authorizedConnector(claim.connectorId)).toBeUndefined();

    const restarted = yield* ConnectorOwner.make(persistence, broker, routePersistence);
    yield* restarted.reload;
    expect((yield* restarted.sessionRouteStatuses)[0]).toMatchObject({
      sessionKey: claim.sessionKey,
      generation: claim.pairingId,
      availability: "expired",
    });
    yield* restarted.detachWebRoute(claim.sessionKey, claim.pairingId);
    expect(yield* restarted.sessionRouteStatuses).toEqual([]);
    expect(yield* Ref.get(routes)).toEqual([]);
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("rebinds the route generation without interrupting an admitted old command", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make<BoundConnector | undefined>(undefined);
    const persistence: BindingPersistence = {
      load: Ref.get(stored),
      save: (binding) => Ref.set(stored, binding),
      clear: Ref.set(stored, undefined),
    };
    const broker = yield* CommandBroker.make;
    const owner = yield* ConnectorOwner.make(persistence, broker);
    const first = {
      pairingId: "44444444-4444-4444-8444-444444444444",
      leaseToken: "1".repeat(64),
      connectorId: primary.connectorId,
      sessionKey: "session:rebind",
    } satisfies WebRunLeaseClaim;
    const second = {
      pairingId: "55555555-5555-4555-8555-555555555555",
      leaseToken: "2".repeat(64),
      connectorId: secondary.connectorId,
      sessionKey: first.sessionKey,
    } satisfies WebRunLeaseClaim;

    yield* owner.registerWebLease(first, primary);
    const admitted = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const oldUse = yield* Effect.forkChild(
      owner.useWebLease(first, () =>
        Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ),
    );
    yield* Deferred.await(admitted);

    yield* owner.registerWebLease(second, secondary);
    expect(yield* owner.hasWebLease(first)).toBe(false);
    expect(yield* owner.hasWebLease(second)).toBe(true);
    expect((yield* owner.sessionRouteStatuses)[0]).toMatchObject({
      generation: second.pairingId,
      connector: { connectorId: second.connectorId },
    });

    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(oldUse);
    expect(yield* owner.authorizedConnector(first.connectorId)).toBeUndefined();
    expect((yield* owner.authorizedConnector(second.connectorId))?.connectorId).toBe(
      second.connectorId,
    );
    yield* broker.stop;
  }).pipe(Effect.provide(nodeServicesLayer)),
);
