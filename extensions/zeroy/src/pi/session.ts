import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import type { ZeroYConnectionRegistryPort } from "@pipee/companion-contracts/zeroy-connection-registry";
import type { WebSurfaceActionOutcome } from "@pipee/companion-contracts/web-surface";
import {
  livePresentation,
  webSurface,
  type WebSurfaceSlot,
  zeroyConnectionRegistry,
} from "@pipee/extension-kit";
import {
  Data,
  Effect,
  Exit,
  ManagedRuntime,
  Scope,
  Schema,
  Semaphore,
  SynchronizedRef,
} from "effect";
import packageJson from "../../package.json" with { type: "json" };
import {
  ZeroYConnectionConfigError,
  connectionFor,
  loadSiteConnections,
  projectRegistryConnection,
  type SiteConnection,
} from "../domain/connection.js";
import type { ExternalCheck } from "../domain/checker.js";
import { zeroYPresentation } from "./presentation.js";
import { ZeroYConnectionAction } from "./web-surface.js";

/**
 * Session is the owner of scoped runtime resources. It consumes the read-only
 * connection projection from the Pipee connection registry; it never owns a
 * second editable connection file.
 */
export type ActiveSession = {
  readonly context: ExtensionContext;
  /** Pi session identity is audit metadata, never Draft ownership. */
  readonly draftActorId: string;
  readonly scope: Scope.Closeable;
  /** Live read-only connection projection; refreshed on registry events. */
  readonly connections: SynchronizedRef.SynchronizedRef<ReadonlyArray<SiteConnection>>;
  /** Registry port when the host provides a persistent connection library. */
  readonly registry: ZeroYConnectionRegistryPort | undefined;
  readonly presentation: LivePresentationPort | undefined;
  readonly surface: WebSurfaceSlot | undefined;
  readonly externalChecks: Map<string, ExternalCheck>;
  readonly mutationGates: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>;
};

export class ZeroYSessionUnavailable extends Data.TaggedError("ZeroYSessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, ActiveSession>();
const runtime = ManagedRuntime.make(nodeServicesLayer);

/**
 * Dispatch one web-surface connection action against the active session's
 * connection registry port. Connection state is shared across sessions (one
 * Pipee registry), so any active session can serve a connection action.
 */
export const dispatchConnectionAction = (
  active: ActiveSession,
  payload: unknown,
): Effect.Effect<WebSurfaceActionOutcome, never> =>
  Schema.decodeUnknownEffect(ZeroYConnectionAction)(payload).pipe(
    Effect.flatMap((action): Effect.Effect<WebSurfaceActionOutcome, ZeroYSessionUnavailable> => {
      const port = active.registry;
      if (port === undefined) {
        return Effect.fail(
          new ZeroYSessionUnavailable({
            message: "zeroY connection registry is unavailable in this session.",
          }),
        );
      }
      switch (action._tag) {
        case "BeginPairing":
          return Effect.tryPromise({
            try: () => port.beginPairing({ endpoint: action.endpoint, label: action.label }),
            catch: (error) =>
              new ZeroYSessionUnavailable({
                message: error instanceof Error ? error.message : String(error),
              }),
          }).pipe(
            Effect.map(
              (intent): WebSurfaceActionOutcome => ({ _tag: "Accepted", payload: intent }),
            ),
          );
        case "PairWithCode":
          return Effect.tryPromise({
            try: () =>
              port.pairWithCode({
                endpoint: action.endpoint,
                intentId: action.intentId,
                code: action.code,
                state: action.state,
                redirectUri: action.redirectUri,
                label: action.label,
              }),
            catch: (error) =>
              new ZeroYSessionUnavailable({
                message: error instanceof Error ? error.message : String(error),
              }),
          }).pipe(
            Effect.map((grant): WebSurfaceActionOutcome => ({ _tag: "Accepted", payload: grant })),
          );
        case "Revoke":
          return Effect.tryPromise({
            try: () => port.revoke(action.siteId),
            catch: (error) =>
              new ZeroYSessionUnavailable({
                message: error instanceof Error ? error.message : String(error),
              }),
          }).pipe(Effect.map((): WebSurfaceActionOutcome => ({ _tag: "Accepted", payload: null })));
      }
    }),
    Effect.match({
      onFailure: (error): WebSurfaceActionOutcome => ({
        _tag: "Failed",
        message: error instanceof Error ? error.message : String(error),
      }),
      onSuccess: (outcome) => outcome,
    }),
  );

export const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>): Promise<A> =>
  runtime.runPromise(effect);

export const activeSession = (pi: ExtensionAPI): ActiveSession | undefined =>
  sessions.get(pi as object);

export const withSession = <A, E, R = NodeServices>(
  pi: ExtensionAPI,
  use: (active: ActiveSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ZeroYSessionUnavailable, R> =>
  Effect.gen(function* () {
    const active = activeSession(pi);
    if (!active) {
      return yield* new ZeroYSessionUnavailable({
        message:
          "zeroY session is unavailable. Start a Pipee session or configure ZEROY_SITES for headless use.",
      });
    }
    return yield* use(active);
  });

export const connection = (
  active: ActiveSession,
  siteId: string,
): Effect.Effect<SiteConnection, ZeroYConnectionConfigError> =>
  SynchronizedRef.get(active.connections).pipe(
    Effect.flatMap((connections) => {
      const selected = connectionFor(connections, siteId);
      return selected instanceof ZeroYConnectionConfigError
        ? Effect.fail(selected)
        : Effect.succeed(selected);
    }),
  );

/** Resolve a grant secret for an outbound Connector request. Never logged. */
export const grantSecretFor = (
  active: ActiveSession,
  siteId: string,
): Effect.Effect<string, ZeroYConnectionConfigError> =>
  SynchronizedRef.get(active.connections).pipe(
    Effect.flatMap((connections) => {
      const selected = connectionFor(connections, siteId);
      if (selected instanceof ZeroYConnectionConfigError) return Effect.fail(selected);
      if (selected.connectionKey !== null) return Effect.succeed(selected.connectionKey);
      if (selected.readGrantSecret === undefined) {
        return Effect.fail(
          new ZeroYConnectionConfigError({
            message: `Connection ${selected.label} has no grant secret. Re-authorize the site.`,
          }),
        );
      }
      return Effect.try({
        try: () => selected.readGrantSecret!(),
        catch: (cause) =>
          new ZeroYConnectionConfigError({
            message: `Could not read grant secret for ${selected.label}: ${String(cause)}`,
          }),
      });
    }),
  );

const loadProjection = (
  registry: ZeroYConnectionRegistryPort | undefined,
): Effect.Effect<ReadonlyArray<SiteConnection>, ZeroYConnectionConfigError> =>
  registry === undefined
    ? loadSiteConnections()
    : Effect.try({
        try: () =>
          registry
            .list()
            .sites.map((projection) =>
              projectRegistryConnection(projection, () =>
                registry.readSecret(projection.credentialRef),
              ),
            ),
        catch: (cause) =>
          new ZeroYConnectionConfigError({
            message: `Could not read zeroY connection projection: ${String(cause)}`,
          }),
      });

export const withLivePresentation = <A, E, R>(
  active: ActiveSession,
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.sync(() =>
    active.presentation?.replace("activity", zeroYPresentation(title, summary, fields)),
  ).pipe(
    Effect.andThen(effect),
    Effect.ensuring(Effect.sync(() => active.presentation?.replace("activity", undefined))),
  );

export const withSiteMutationGate = <A, E, R>(
  active: ActiveSession,
  siteId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ZeroYSessionUnavailable, R> =>
  Effect.gen(function* () {
    const gates = yield* SynchronizedRef.get(active.mutationGates);
    const gate = gates.get(siteId);
    if (!gate) {
      return yield* new ZeroYSessionUnavailable({
        message: `zeroY write gate is unavailable for site ${siteId}.`,
      });
    }
    return yield* gate.withPermits(1)(effect);
  }).pipe(
    Effect.withSpan("zeroy.mutation.site-serialized", {
      attributes: { "zeroy.site_id": siteId },
    }),
  );

export const stopSession = (pi: ExtensionAPI, active: ActiveSession): Effect.Effect<void> =>
  Scope.close(active.scope, Exit.succeed(undefined)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        active.presentation?.replace("activity", undefined);
        sessions.delete(pi as object);
      }),
    ),
  );

export const startSession = (
  pi: ExtensionAPI,
  context: ExtensionContext,
  refresh: (active: ActiveSession) => Effect.Effect<void, never, NodeServices>,
): Effect.Effect<void, ZeroYConnectionConfigError | ZeroYSessionUnavailable, NodeServices> =>
  Effect.gen(function* () {
    const previous = activeSession(pi);
    if (previous) yield* stopSession(pi, previous);
    const scope = yield* Scope.make("sequential");
    yield* Effect.gen(function* () {
      // The host capability is the persistent connection library. When the
      // host does not expose it (unit tests, headless adapter), fall back to
      // the EnvironmentInjected ZEROY_SITES source. A missing registry is not
      // an error: zeroY starts with zero connections.
      const registry = context.hasUI
        ? zeroyConnectionRegistry(context.ui, packageJson.name)
        : undefined;
      const connections = yield* loadProjection(registry);
      const draftActorId = context.sessionManager.getSessionId().trim();
      if (draftActorId === "") {
        return yield* new ZeroYSessionUnavailable({
          message: "zeroY requires a Pi session ID for SiteCommit author metadata.",
        });
      }
      const connectionRef = yield* SynchronizedRef.make(connections);
      const gatesRef = yield* SynchronizedRef.make(
        new Map(connections.map((site) => [site.siteId, Semaphore.makeUnsafe(1)] as const)),
      );
      const surface = context.hasUI
        ? yield* webSurface(context.ui, packageJson.name, (request) =>
            run(dispatchConnectionAction(active, request.payload)),
          ).pipe(
            Effect.catchTag("WebSurfaceCapabilityUnavailable", () =>
              Effect.void.pipe(Effect.as(undefined)),
            ),
          )
        : undefined;
      let active!: ActiveSession;
      active = {
        context,
        draftActorId,
        scope,
        connections: connectionRef,
        registry,
        presentation: context.hasUI ? livePresentation(context.ui, packageJson.name) : undefined,
        surface,
        externalChecks: new Map(),
        mutationGates: gatesRef,
      };
      // Connection directory changes refresh the projection live so existing
      // sessions see new sites without restart, and dropped sites disappear.
      if (registry !== undefined) {
        const unsubscribe = registry.subscribe(() => {
          const next = loadProjection(registry);
          void run(
            next.pipe(
              Effect.flatMap((projected) =>
                SynchronizedRef.set(connectionRef, projected).pipe(
                  Effect.flatMap(() =>
                    SynchronizedRef.set(
                      gatesRef,
                      new Map(
                        projected.map((site) => [site.siteId, Semaphore.makeUnsafe(1)] as const),
                      ),
                    ),
                  ),
                ),
              ),
              Effect.flatMap(() => refresh(active)),
              Effect.catch((error) =>
                Effect.logWarning("zeroY connection refresh failed", { error: String(error) }),
              ),
            ),
          );
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));
      }
      yield* Effect.sync(() => sessions.set(pi as object, active));
      if (surface !== undefined) yield* refresh(active);
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() =>
        Scope.close(
          scope,
          Exit.fail(new ZeroYSessionUnavailable({ message: "zeroY session startup failed." })),
        ),
      ),
    );
  });
