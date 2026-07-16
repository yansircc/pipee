import type { NodeServices } from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { CommandBroker } from "../core/broker.js";
import {
  ConnectorAlreadyBound,
  ConnectorBindingMismatch,
  ConnectorNotBound,
  WebConnectorLeaseUnavailable,
} from "../core/errors.js";
import { WEB_RUN_LEASE_LIFETIME_MS } from "../protocol/bridge-contract.js";
import type {
  BoundConnector,
  ProfileConnector,
  PublicConnector,
  SessionWebRouteStatus,
  WebRunLeaseClaim,
} from "../protocol/schema.js";
import type { ConnectorBindingStoreFailure } from "./connector-binding.js";
import type {
  PersistedSessionConnectorBinding,
  SessionConnectorBindingPersistence,
} from "./session-connector-binding.js";

export interface BindingPersistence {
  readonly load: Effect.Effect<
    BoundConnector | undefined,
    ConnectorBindingStoreFailure,
    NodeServices
  >;
  readonly save: (
    binding: BoundConnector,
  ) => Effect.Effect<void, ConnectorBindingStoreFailure, NodeServices>;
  readonly clear: Effect.Effect<void, ConnectorBindingStoreFailure, NodeServices>;
}

type WebLease = {
  readonly claim: WebRunLeaseClaim;
  readonly connector: ProfileConnector;
  readonly expiresAt: number;
  readonly uses: number;
  readonly releasing: boolean;
  readonly idle: Deferred.Deferred<void>;
};

type WebRoute = {
  readonly sessionKey: string;
  readonly generation: string;
  readonly connector: ProfileConnector;
  readonly live:
    | {
        readonly claim: WebRunLeaseClaim;
        readonly expiresAt: number;
      }
    | undefined;
};

type ConnectorOwnerState = {
  readonly binding: BoundConnector | undefined;
  readonly webRoutes: ReadonlyMap<string, WebRoute>;
  readonly webLeases: ReadonlyMap<string, WebLease>;
};

const publicConnector = (connector: ProfileConnector): PublicConnector => ({
  connectorId: connector.connectorId,
  label: connector.label,
  extensionId: connector.extensionId,
  extensionDisplayVersion: connector.extensionDisplayVersion,
  protocolFingerprint: connector.protocolFingerprint,
});

const sameConnectorAuthority = (left: ProfileConnector, right: ProfileConnector): boolean =>
  left.connectorId === right.connectorId &&
  left.secret === right.secret &&
  left.extensionId === right.extensionId;

const sameConnector = (left: ProfileConnector, right: ProfileConnector): boolean =>
  sameConnectorAuthority(left, right) &&
  left.label === right.label &&
  left.extensionDisplayVersion === right.extensionDisplayVersion &&
  left.protocolFingerprint === right.protocolFingerprint;

const sameClaim = (left: WebRunLeaseClaim, right: WebRunLeaseClaim): boolean =>
  left.pairingId === right.pairingId &&
  left.leaseToken === right.leaseToken &&
  left.connectorId === right.connectorId &&
  left.sessionKey === right.sessionKey;

const activeConnectorRecords = (state: ConnectorOwnerState): ReadonlyArray<ProfileConnector> => [
  ...(state.binding ? [state.binding] : []),
  ...[...state.webLeases.values()].map(({ connector }) => connector),
];

const knownConnectorRecords = (state: ConnectorOwnerState): ReadonlyArray<ProfileConnector> => [
  ...activeConnectorRecords(state),
  ...[...state.webRoutes.values()].map(({ connector }) => connector),
];

const connectorIds = (state: ConnectorOwnerState): ReadonlySet<string> =>
  new Set(activeConnectorRecords(state).map(({ connectorId }) => connectorId));

const ephemeralSessionBindings: SessionConnectorBindingPersistence = {
  load: Effect.succeed([]),
  save: () => Effect.void,
};

const persistedWebRoutes = (
  webRoutes: ReadonlyMap<string, WebRoute>,
): ReadonlyArray<PersistedSessionConnectorBinding> =>
  [...webRoutes.values()].map(({ sessionKey, generation, connector, live }) => ({
    sessionKey,
    generation,
    connector,
    ...(live ? { live } : {}),
  }));

export class ConnectorOwner {
  private constructor(
    private readonly persistence: BindingPersistence,
    private readonly state: Ref.Ref<ConnectorOwnerState>,
    private readonly broker: CommandBroker,
    private readonly transitionLock: Semaphore.Semaphore,
    private readonly sessionBindings: SessionConnectorBindingPersistence,
  ) {}

  static make = (
    persistence: BindingPersistence,
    broker: CommandBroker,
    sessionBindings: SessionConnectorBindingPersistence = ephemeralSessionBindings,
  ) =>
    Effect.all({
      state: Ref.make<ConnectorOwnerState>({
        binding: undefined,
        webRoutes: new Map(),
        webLeases: new Map(),
      }),
      transitionLock: Semaphore.make(1),
    }).pipe(
      Effect.map(
        ({ state, transitionLock }) =>
          new ConnectorOwner(persistence, state, broker, transitionLock, sessionBindings),
      ),
    );

  get current(): Effect.Effect<BoundConnector | undefined> {
    return Ref.get(this.state).pipe(Effect.map(({ binding }) => binding));
  }

  get sessionRouteStatuses(): Effect.Effect<ReadonlyArray<SessionWebRouteStatus>> {
    return this.transition(
      this.pruneExpired.pipe(
        Effect.andThen(Ref.get(this.state)),
        Effect.flatMap(({ webRoutes }) =>
          Effect.forEach(
            [...webRoutes.values()],
            (route): Effect.Effect<SessionWebRouteStatus> =>
              route.live
                ? this.broker.status(route.connector.connectorId).pipe(
                    Effect.map((status) => ({
                      source: "web" as const,
                      sessionKey: route.sessionKey,
                      generation: route.generation,
                      connector:
                        status.extensionId === undefined
                          ? publicConnector(route.connector)
                          : {
                              connectorId: status.connectorId,
                              label: status.label,
                              extensionId: status.extensionId,
                              extensionDisplayVersion: status.extensionDisplayVersion,
                              protocolFingerprint: status.protocolFingerprint,
                            },
                      availability: "live" as const,
                      claim: route.live!.claim,
                      expiresAt: route.live!.expiresAt,
                      connected: status.connected,
                    })),
                  )
                : Effect.succeed({
                    source: "web" as const,
                    sessionKey: route.sessionKey,
                    generation: route.generation,
                    connector: publicConnector(route.connector),
                    availability: "expired" as const,
                    connected: false as const,
                  }),
            { concurrency: "unbounded" },
          ),
        ),
      ),
    );
  }

  get requireBoundConnector(): Effect.Effect<BoundConnector, ConnectorNotBound> {
    return this.transitionLock.withPermits(1)(
      Ref.get(this.state).pipe(
        Effect.flatMap(({ binding }) =>
          binding
            ? Effect.succeed(binding)
            : Effect.fail(
                new ConnectorNotBound({
                  message: "No Chrome profile is paired. Run /chrome onboard first.",
                }),
              ),
        ),
      ),
    );
  }

  expectBoundConnector(
    expectedConnectorId: string,
  ): Effect.Effect<BoundConnector, ConnectorNotBound | ConnectorBindingMismatch> {
    return this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const { binding } = yield* Ref.get(this.state);
        if (!binding) {
          return yield* new ConnectorNotBound({
            message: "No Chrome profile is paired. Run /chrome onboard first.",
          });
        }
        if (binding.connectorId === expectedConnectorId) return binding;
        return yield* new ConnectorBindingMismatch({
          expectedConnectorId,
          actualConnectorId: binding.connectorId,
          message: `Expected Chrome connector ${expectedConnectorId.slice(0, 8)}, but owner is bound to ${binding.connectorId.slice(0, 8)}`,
        });
      }),
    );
  }

  get expectNoConnector(): Effect.Effect<void, ConnectorAlreadyBound> {
    return this.transitionLock.withPermits(1)(
      Ref.get(this.state).pipe(
        Effect.flatMap(({ binding }) =>
          binding
            ? Effect.fail(
                new ConnectorAlreadyBound({
                  actualConnectorId: binding.connectorId,
                  message: `Expected no Chrome connector, but owner is bound to ${binding.connectorId.slice(0, 8)}`,
                }),
              )
            : Effect.void,
        ),
      ),
    );
  }

  get reload(): Effect.Effect<void, ConnectorBindingStoreFailure, NodeServices> {
    return this.transition(
      Effect.gen({ self: this }, function* () {
        const [binding, persisted] = yield* Effect.all([
          this.persistence.load,
          this.sessionBindings.load,
        ]);
        const now = yield* Clock.currentTimeMillis;
        const webRoutes = new Map<string, WebRoute>();
        const webLeases = new Map<string, WebLease>();
        for (const entry of persisted) {
          const live = entry.live && entry.live.expiresAt > now ? entry.live : undefined;
          webRoutes.set(entry.sessionKey, {
            sessionKey: entry.sessionKey,
            generation: entry.generation,
            connector: entry.connector,
            live,
          });
          if (live) {
            webLeases.set(live.claim.pairingId, {
              claim: live.claim,
              connector: entry.connector,
              expiresAt: live.expiresAt,
              uses: 0,
              releasing: false,
              idle: yield* Deferred.make<void>(),
            });
          }
        }
        const state = yield* Ref.get(this.state);
        yield* this.publish({ ...state, binding, webRoutes, webLeases });
      }),
    );
  }

  replace(
    binding: BoundConnector,
  ): Effect.Effect<void, ConnectorBindingStoreFailure | ConnectorBindingMismatch, NodeServices> {
    return this.transition(
      Effect.gen({ self: this }, function* () {
        const state = yield* Ref.get(this.state);
        yield* this.ensureConnectorConsistent(state, binding);
        yield* this.persistence.save(binding);
        yield* this.publish({ ...state, binding });
      }),
    );
  }

  get clear(): Effect.Effect<void, ConnectorBindingStoreFailure, NodeServices> {
    return this.transition(
      Effect.gen({ self: this }, function* () {
        yield* this.persistence.clear;
        const state = yield* Ref.get(this.state);
        yield* this.publish({ ...state, binding: undefined });
      }),
    );
  }

  hasWebLease(claim: WebRunLeaseClaim): Effect.Effect<boolean> {
    return this.transition(
      this.pruneExpired.pipe(
        Effect.andThen(Ref.get(this.state)),
        Effect.map(({ webLeases, webRoutes }) => {
          const lease = webLeases.get(claim.pairingId);
          const route = webRoutes.get(claim.sessionKey);
          return (
            lease !== undefined &&
            !lease.releasing &&
            sameClaim(lease.claim, claim) &&
            route?.generation === claim.pairingId &&
            route.live !== undefined &&
            sameClaim(route.live.claim, claim)
          );
        }),
      ),
    );
  }

  registerWebLease(
    claim: WebRunLeaseClaim,
    connector: ProfileConnector,
  ): Effect.Effect<
    void,
    WebConnectorLeaseUnavailable | ConnectorBindingMismatch | ConnectorBindingStoreFailure,
    NodeServices
  > {
    return this.transition(
      Effect.gen({ self: this }, function* () {
        yield* this.pruneExpired;
        const state = yield* Ref.get(this.state);
        const existing = state.webLeases.get(claim.pairingId);
        if (existing) {
          const route = state.webRoutes.get(claim.sessionKey);
          if (
            sameClaim(existing.claim, claim) &&
            sameConnector(existing.connector, connector) &&
            route?.generation === claim.pairingId &&
            route.live !== undefined &&
            sameClaim(route.live.claim, claim)
          ) {
            return;
          }
          return yield* new WebConnectorLeaseUnavailable({
            pairingId: claim.pairingId,
            message: `Web connector lease ${claim.pairingId} is already owned by another session route`,
          });
        }
        if (claim.connectorId !== connector.connectorId) {
          return yield* new WebConnectorLeaseUnavailable({
            pairingId: claim.pairingId,
            message: "Web connector lease does not match the confirmed Chrome connector",
          });
        }
        yield* this.ensureConnectorConsistent(state, connector);
        const refreshedBinding =
          state.binding &&
          sameConnectorAuthority(state.binding, connector) &&
          !sameConnector(state.binding, connector)
            ? { ...connector, pairedAt: state.binding.pairedAt }
            : undefined;
        if (refreshedBinding) yield* this.persistence.save(refreshedBinding);
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = now + WEB_RUN_LEASE_LIFETIME_MS;
        const webLeases = new Map(state.webLeases);
        for (const [pairingId, lease] of webLeases) {
          if (lease.claim.sessionKey !== claim.sessionKey) continue;
          if (lease.uses > 0) {
            webLeases.set(pairingId, { ...lease, releasing: true });
          } else {
            webLeases.delete(pairingId);
          }
        }
        webLeases.set(claim.pairingId, {
          claim,
          connector,
          expiresAt,
          uses: 0,
          releasing: false,
          idle: yield* Deferred.make<void>(),
        });
        const webRoutes = new Map(state.webRoutes).set(claim.sessionKey, {
          sessionKey: claim.sessionKey,
          generation: claim.pairingId,
          connector,
          live: { claim, expiresAt },
        });
        yield* this.sessionBindings.save(persistedWebRoutes(webRoutes));
        yield* this.publish({
          ...state,
          binding: refreshedBinding ?? state.binding,
          webRoutes,
          webLeases,
        });
      }),
    );
  }

  releaseWebLease(
    claim: WebRunLeaseClaim,
  ): Effect.Effect<
    void,
    WebConnectorLeaseUnavailable | ConnectorBindingStoreFailure,
    NodeServices
  > {
    return Effect.gen({ self: this }, function* () {
      const marked = yield* this.transitionLock.withPermits(1)(
        Effect.gen({ self: this }, function* () {
          yield* this.pruneExpired;
          const state = yield* Ref.get(this.state);
          const existing = state.webLeases.get(claim.pairingId);
          if (existing && !sameClaim(existing.claim, claim)) {
            return yield* new WebConnectorLeaseUnavailable({
              pairingId: claim.pairingId,
              message: `Web connector lease ${claim.pairingId} is owned by another session route`,
            });
          }
          const route = state.webRoutes.get(claim.sessionKey);
          const removesRoute = route?.generation === claim.pairingId;
          const webRoutes = new Map(state.webRoutes);
          if (removesRoute) {
            webRoutes.delete(claim.sessionKey);
            yield* this.sessionBindings.save(persistedWebRoutes(webRoutes));
          }
          const webLeases = new Map(state.webLeases);
          if (existing && !existing.releasing) {
            webLeases.set(claim.pairingId, { ...existing, releasing: true });
          }
          if (removesRoute || existing) {
            yield* this.publish({ ...state, webRoutes, webLeases });
          }
          return existing;
        }),
      );
      if (!marked) return;
      if (marked.uses > 0) yield* Deferred.await(marked.idle);
      yield* this.transition(
        Effect.gen({ self: this }, function* () {
          const state = yield* Ref.get(this.state);
          const existing = state.webLeases.get(claim.pairingId);
          if (!existing || !sameClaim(existing.claim, claim)) return;
          const webLeases = new Map(state.webLeases);
          webLeases.delete(claim.pairingId);
          yield* this.publish({ ...state, webLeases });
        }),
      );
    });
  }

  detachWebRoute(
    sessionKey: string,
    generation: string,
  ): Effect.Effect<void, ConnectorBindingStoreFailure, NodeServices> {
    return Effect.gen({ self: this }, function* () {
      const marked = yield* this.transitionLock.withPermits(1)(
        Effect.gen({ self: this }, function* () {
          yield* this.pruneExpired;
          const state = yield* Ref.get(this.state);
          const route = state.webRoutes.get(sessionKey);
          if (!route || route.generation !== generation) return undefined;
          const webRoutes = new Map(state.webRoutes);
          webRoutes.delete(sessionKey);
          yield* this.sessionBindings.save(persistedWebRoutes(webRoutes));
          const candidate = state.webLeases.get(generation);
          const existing = candidate?.claim.sessionKey === sessionKey ? candidate : undefined;
          const webLeases = new Map(state.webLeases);
          if (existing) {
            webLeases.set(existing.claim.pairingId, { ...existing, releasing: true });
          }
          yield* this.publish({ ...state, webRoutes, webLeases });
          return existing;
        }),
      );
      if (!marked) return;
      if (marked.uses > 0) yield* Deferred.await(marked.idle);
      yield* this.transition(
        Effect.gen({ self: this }, function* () {
          const state = yield* Ref.get(this.state);
          const existing = state.webLeases.get(marked.claim.pairingId);
          if (!existing || !sameClaim(existing.claim, marked.claim)) return;
          const webLeases = new Map(state.webLeases);
          webLeases.delete(marked.claim.pairingId);
          yield* this.publish({ ...state, webLeases });
        }),
      );
    });
  }

  useWebLease<A, E, R>(
    claim: WebRunLeaseClaim,
    use: (connector: ProfileConnector) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WebConnectorLeaseUnavailable, R> {
    const acquire = this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        yield* this.pruneExpired;
        const state = yield* Ref.get(this.state);
        const lease = state.webLeases.get(claim.pairingId);
        const route = state.webRoutes.get(claim.sessionKey);
        if (
          !lease ||
          lease.releasing ||
          !sameClaim(lease.claim, claim) ||
          route?.generation !== claim.pairingId ||
          !route.live ||
          !sameClaim(route.live.claim, claim)
        ) {
          return yield* new WebConnectorLeaseUnavailable({
            pairingId: claim.pairingId,
            message: `Chrome connector route for ${claim.sessionKey} is unavailable, expired, or replaced`,
          });
        }
        yield* Ref.set(this.state, {
          ...state,
          webLeases: new Map(state.webLeases).set(claim.pairingId, {
            ...lease,
            uses: lease.uses + 1,
          }),
        });
        return lease.connector;
      }),
    );
    return Effect.acquireUseRelease(acquire, use, () => this.releaseWebLeaseUse(claim));
  }

  authorizedConnector(connectorId: string): Effect.Effect<ProfileConnector | undefined> {
    return this.transition(
      this.pruneExpired.pipe(
        Effect.andThen(Ref.get(this.state)),
        Effect.map((state) =>
          activeConnectorRecords(state).find((connector) => connector.connectorId === connectorId),
        ),
      ),
    );
  }

  private get pruneExpired(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* Ref.get(this.state);
      const webRoutes = new Map(state.webRoutes);
      for (const [sessionKey, route] of webRoutes) {
        if (route.live && route.live.expiresAt <= now) {
          webRoutes.set(sessionKey, { ...route, live: undefined });
        }
      }
      const webLeases = new Map(
        [...state.webLeases].filter(([, lease]) => lease.expiresAt > now || lease.uses > 0),
      );
      if (
        webRoutes.size !== state.webRoutes.size ||
        [...webRoutes].some(([sessionKey, route]) => state.webRoutes.get(sessionKey) !== route) ||
        webLeases.size !== state.webLeases.size
      ) {
        yield* this.publish({ ...state, webRoutes, webLeases });
      }
    });
  }

  private releaseWebLeaseUse(claim: WebRunLeaseClaim): Effect.Effect<void> {
    return this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const state = yield* Ref.get(this.state);
        const lease = state.webLeases.get(claim.pairingId);
        if (!lease || !sameClaim(lease.claim, claim) || lease.uses === 0) return;
        const uses = lease.uses - 1;
        const now = yield* Clock.currentTimeMillis;
        const route = state.webRoutes.get(claim.sessionKey);
        const routeOwnsLease =
          route?.generation === claim.pairingId &&
          route.live !== undefined &&
          sameClaim(route.live.claim, claim);
        const remove = uses === 0 && (lease.releasing || lease.expiresAt <= now || !routeOwnsLease);
        const webLeases = new Map(state.webLeases);
        if (remove) webLeases.delete(claim.pairingId);
        else webLeases.set(claim.pairingId, { ...lease, uses });
        yield* this.publish({ ...state, webLeases });
        if (uses === 0 && lease.releasing) yield* Deferred.succeed(lease.idle, undefined);
      }),
    );
  }

  private ensureConnectorConsistent(
    state: ConnectorOwnerState,
    connector: ProfileConnector,
  ): Effect.Effect<void, ConnectorBindingMismatch> {
    const existing = knownConnectorRecords(state).find(
      ({ connectorId }) => connectorId === connector.connectorId,
    );
    return existing && !sameConnectorAuthority(existing, connector)
      ? Effect.fail(
          new ConnectorBindingMismatch({
            expectedConnectorId: existing.connectorId,
            actualConnectorId: connector.connectorId,
            message: `Chrome connector ${connector.connectorId.slice(0, 8)} presented conflicting identity data`,
          }),
        )
      : Effect.void;
  }

  private transition<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return this.transitionLock.withPermits(1)(Effect.uninterruptible(effect));
  }

  private publish(next: ConnectorOwnerState): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const previous = yield* Ref.get(this.state);
      const before = connectorIds(previous);
      const after = connectorIds(next);
      yield* Effect.forEach(
        [...after].filter((connectorId) => !before.has(connectorId)),
        (connectorId) => this.broker.register(connectorId),
        { discard: true },
      );
      yield* Ref.set(this.state, next);
      yield* Effect.forEach(
        [...before].filter((connectorId) => !after.has(connectorId)),
        (connectorId) => this.broker.drop(connectorId),
        { discard: true },
      );
    });
  }
}
