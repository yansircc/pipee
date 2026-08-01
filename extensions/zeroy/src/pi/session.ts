import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import { livePresentation, webSurface, type WebSurfaceSlot } from "@pipee/extension-kit";
import { Data, Effect, Exit, ManagedRuntime, Scope, Semaphore } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import {
  ZeroYConnectionConfigError,
  connectionFor,
  loadSiteConnections,
  type SiteConnection,
} from "../domain/connection.js";
import type { ExternalCheck } from "../domain/checker.js";
import { zeroYPresentation } from "./presentation.js";

/**
 * Session is the owner of scoped runtime resources. Domain tools can read this
 * projection but cannot create or retain a second session state.
 */
export type ActiveSession = {
  readonly context: ExtensionContext;
  /** Pi session identity, forwarded only as the remote SiteDraft owner. */
  readonly draftOwnerId: string;
  readonly scope: Scope.Closeable;
  readonly connections: ReadonlyArray<SiteConnection>;
  readonly presentation: LivePresentationPort | undefined;
  readonly surface: WebSurfaceSlot | undefined;
  readonly externalChecks: Map<string, ExternalCheck>;
  readonly mutationGates: ReadonlyMap<string, Semaphore.Semaphore>;
};

export class ZeroYSessionUnavailable extends Data.TaggedError("ZeroYSessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, ActiveSession>();
const runtime = ManagedRuntime.make(nodeServicesLayer);

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
          "zeroY session is unavailable. Configure ZEROY_SITES before creating the Pipee session.",
      });
    }
    return yield* use(active);
  });

export const connection = (
  active: ActiveSession,
  siteId: string,
): Effect.Effect<SiteConnection, ZeroYConnectionConfigError> => {
  const selected = connectionFor(active.connections, siteId);
  return selected instanceof ZeroYConnectionConfigError
    ? Effect.fail(selected)
    : Effect.succeed(selected);
};

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
    const gate = active.mutationGates.get(siteId);
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
      const connections = yield* loadSiteConnections();
      const draftOwnerId = context.sessionManager.getSessionId().trim();
      if (draftOwnerId === "") {
        return yield* new ZeroYSessionUnavailable({
          message: "zeroY requires a stable Pi session ID to own remote SiteDrafts.",
        });
      }
      const mutationGates = new Map(
        yield* Effect.forEach(connections, (site) =>
          Semaphore.make(1).pipe(Effect.map((gate) => [site.siteId, gate] as const)),
        ),
      );
      const surface = context.hasUI
        ? yield* webSurface(context.ui, packageJson.name, () => ({
            _tag: "Rejected" as const,
            reason:
              "zeroY WebSurface is read-only; ask the Agent to make changes in the conversation.",
          })).pipe(
            Effect.catchTag("WebSurfaceCapabilityUnavailable", () =>
              Effect.void.pipe(Effect.as(undefined)),
            ),
          )
        : undefined;
      const active: ActiveSession = {
        context,
        draftOwnerId,
        scope,
        connections,
        presentation: context.hasUI ? livePresentation(context.ui, packageJson.name) : undefined,
        surface,
        externalChecks: new Map(),
        mutationGates,
      };
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
