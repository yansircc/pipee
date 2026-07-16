import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import { AuthorizationFailure, messageOf } from "../core/errors.js";
import { BRIDGE_HOST, BRIDGE_PORT } from "../protocol/bridge-contract.js";
import type { SessionContext } from "../protocol/schema.js";
import type { WebRunLeaseClaim } from "../protocol/schema.js";
import { bridgeDeliveryTimeoutMs } from "../protocol/timeout.js";
import { json } from "./format.js";
import {
  AUTHORIZATION_ENTRY_TYPE,
  AuthorizationOwner,
  restoreAuthorizationOwnerFromSession,
  type Authorization,
  type SessionAuthorizationEntry,
} from "./authorization-owner.js";
import {
  chromeCommandCompletions,
  parseChromeCommand,
  type AuthorizationRequest,
  type ChromeCommand,
} from "./chrome-command.js";
import { makeConnectorBindingStore } from "./connector-binding.js";
import { NodeBridge } from "./node-bridge.js";
import { formatPairingTimeRemaining } from "./pairing-expiry.js";
import {
  SessionRuntimeOwner,
  type AuthorizedSessionClaim,
  type SessionAuthorizationMutation,
  type SessionIdentity,
  type SessionScope,
} from "./session-runtime-owner.js";
import { executeChromeTool } from "./tool-execution.js";
import {
  RunConnectorOwner,
  type DetachedWebRoute,
  type RunConnectorClaim,
  type RunConnectorSelection,
} from "./run-connector-owner.js";
import {
  projectChromeStatus,
  type BridgeStatusSnapshot,
  type ChromeStatusProjection,
} from "./status-projection.js";
import { decodeWebRunOfferToken } from "./web-run-offer.js";
import {
  CHROME_DEFAULT_TOOL_NAMES,
  CHROME_TOOL_NAMES,
  activateChromeTools,
  enableChromeProfile,
  registerChromeTools,
  revokeChromeTools,
  type AdvancedChromeProfile,
  type ToolResult,
} from "./tools.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../dist/browser-extension/", import.meta.url));
const registrations = new WeakSet<object>();
const effectRuntime = ManagedRuntime.make(Layer.empty);

type StructuredStatusUi = ExtensionContext["ui"] & {
  setStructuredStatus?: (key: string, status: ChromeStatusProjection | undefined) => void;
};

const provideNode = <A, E>(effect: Effect.Effect<A, E, NodeServices>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));

const makeBridge = (): NodeBridge => {
  const bindingStore = effectRuntime.runSync(makeConnectorBindingStore());
  return effectRuntime.runSync(
    NodeBridge.make(BRIDGE_HOST, BRIDGE_PORT, () => packageJson.version, bindingStore),
  );
};

const workspaceCwd = (context: ExtensionContext): string => context.cwd || process.cwd();

const resolveSessionIdentity = (
  context: ExtensionContext,
): Effect.Effect<SessionIdentity, AuthorizationFailure> =>
  Effect.suspend(() => {
    const id = context.sessionManager.getSessionId?.()?.trim();
    if (!id) {
      return Effect.fail(
        new AuthorizationFailure({
          message: "Pi session id is unavailable; Chrome ownership is refused",
        }),
      );
    }
    const name = context.sessionManager.getSessionName?.()?.trim();
    return Effect.succeed({
      key: `session:${id}`,
      groupTitle: `Pi Session: ${name || id}`.slice(0, 80),
    });
  });

const now = (): number => effectRuntime.runSync(Clock.currentTimeMillis);

export default function piChrome(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  const bridge = makeBridge();
  registrations.add(pi as object);

  const sessions = new SessionRuntimeOwner();
  const runConnectors = new RunConnectorOwner();
  const sessionTransitions = Semaphore.makeUnsafe(1);
  const authorizationTransitions = Semaphore.makeUnsafe(1);
  const connectorTransitions = Semaphore.makeUnsafe(1);
  let toolsRegistered = false;
  let expiryFiber: Fiber.Fiber<void, never> | undefined;
  let statusFiber: Fiber.Fiber<void, never> | undefined;

  const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>, signal?: AbortSignal): Promise<A> =>
    effectRuntime.runPromise(provideNode(effect), signal ? { signal } : undefined);

  const runDetached = <A, E>(effect: Effect.Effect<A, E, NodeServices>): void => {
    effectRuntime.runFork(provideNode(effect));
  };

  const isAuthorized = (): boolean => {
    const snapshot = sessions.snapshot(now());
    return snapshot._tag === "Active" && snapshot.authorized;
  };

  const backgroundEnabled = (): boolean => {
    const snapshot = sessions.snapshot(now());
    return snapshot._tag === "Active" || snapshot._tag === "Poisoned" ? snapshot.background : false;
  };

  const activateTools = (): void => {
    if (!toolsRegistered) {
      registerChromeTools(pi, executeTool, enableToolProfile);
      toolsRegistered = true;
    }
    pi.setActiveTools(activateChromeTools(pi.getActiveTools()));
  };

  const deactivateTools = (): void => pi.setActiveTools(revokeChromeTools(pi.getActiveTools()));

  const cancelExpiry = (): void => {
    if (expiryFiber) runDetached(Fiber.interrupt(expiryFiber));
    expiryFiber = undefined;
  };

  const cancelStatusRefresh = (): void => {
    if (statusFiber) runDetached(Fiber.interrupt(statusFiber));
    statusFiber = undefined;
  };

  const appendAuthorizationEntry = (entry: SessionAuthorizationEntry): void =>
    pi.appendEntry(AUTHORIZATION_ENTRY_TYPE, entry);

  const sendWithConnector = <AdmissionError, AdmissionRequirements>(
    connector: RunConnectorClaim["selection"],
    admission: Effect.Effect<void, AdmissionError, AdmissionRequirements>,
    request: Parameters<NodeBridge["send"]>[0],
    session: SessionContext,
    timeoutMs: number,
  ) =>
    connector.source === "web"
      ? bridge.sendWebGuarded(connector.claim, admission, request, session, timeoutMs)
      : bridge.sendTerminalGuarded(
          connector.expectedConnectorId,
          admission,
          request,
          session,
          timeoutMs,
        );

  const cleanupThrough = (
    scope: SessionScope,
    connector: RunConnectorClaim["selection"],
  ): Effect.Effect<void, never, NodeServices> =>
    sendWithConnector(
      connector,
      Effect.void,
      { domain: "system", call: { op: "cleanup" } },
      { ...scope.identity, foreground: false },
      3_000,
    ).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.sync(() =>
          scope.context.ui.notify(
            `Chrome target cleanup failed for ${scope.identity.key}: ${messageOf(error)}`,
            "warning",
          ),
        ),
      ),
    );

  const cleanupSessionTarget = (
    scope: SessionScope,
    explicitConnector?: RunConnectorSelection,
  ): Effect.Effect<void, never, NodeServices> =>
    Effect.suspend(() => {
      const connector = explicitConnector ?? runConnectors.selection(scope);
      return connector ? cleanupThrough(scope, connector) : Effect.void;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() =>
          scope.context.ui.notify(
            `Chrome connector cleanup lookup failed for ${scope.identity.key}: ${messageOf(error)}`,
            "warning",
          ),
        ),
      ),
    );

  const beginSessionTransition = (): Readonly<{
    epoch: number;
    previous: SessionScope | undefined;
    connectors: ReadonlyArray<RunConnectorSelection>;
  }> => {
    const transition = sessions.begin();
    const connectors = runConnectors.begin();
    cancelExpiry();
    cancelStatusRefresh();
    deactivateTools();
    if (transition.previous) clearStatus(transition.previous.context);
    return { ...transition, connectors };
  };

  const releaseWebLease = (
    scope: SessionScope,
    claim: WebRunLeaseClaim,
  ): Effect.Effect<void, never, NodeServices> =>
    bridge
      .releaseWebRunLease(claim)
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            scope.context.ui.notify(
              `Chrome web lease release failed for ${scope.identity.key}: ${messageOf(error)}`,
              "warning",
            ),
          ),
        ),
      );

  const detachSessionWebRoute = (
    scope: SessionScope,
    route: DetachedWebRoute,
  ): Effect.Effect<void, unknown, NodeServices> =>
    route.claim
      ? bridge.releaseWebRunLease(route.claim)
      : bridge.detachSessionWebRoute(scope.identity.key, route.generation);

  const requireConnectorSelection = (
    scope: SessionScope,
  ): Effect.Effect<RunConnectorSelection, AuthorizationFailure> =>
    Effect.suspend(() => {
      const selection = runConnectors.selection(scope);
      if (selection) return Effect.succeed(selection);
      const route = runConnectors.webRoute(scope);
      return Effect.fail(
        new AuthorizationFailure({
          message: route
            ? `The Chrome connector attached to ${scope.identity.key} is unavailable or expired`
            : `No Chrome connector is attached to ${scope.identity.key}`,
        }),
      );
    });

  const requireSessionScope = (
    ctx: ExtensionContext,
  ): Effect.Effect<SessionScope, AuthorizationFailure> =>
    resolveSessionIdentity(ctx).pipe(
      Effect.flatMap((identity) =>
        Effect.suspend(() => {
          const scope = sessions.scopeFor(ctx, identity);
          if (!scope) {
            return Effect.fail(
              new AuthorizationFailure({
                message: `Pi session ${identity.key} is not the active Chrome authorization owner`,
              }),
            );
          }
          return Effect.succeed(scope);
        }),
      ),
    );

  const activeAuthorizationState = (scope: SessionScope) =>
    Effect.suspend(() => {
      const access = sessions.authorizationState(scope, now());
      if (access._tag === "Stale") {
        return Effect.fail(
          new AuthorizationFailure({
            message: `Pi session ${scope.identity.key} changed before Chrome authorization was used`,
          }),
        );
      }
      if (access._tag === "Poisoned") {
        return Effect.fail(
          new AuthorizationFailure({
            message:
              "Chrome authorization ledger is fail-closed after a partial append; run /chrome revoke to repair it",
          }),
        );
      }
      return Effect.succeed(access);
    });

  const ensureSessionScope = (scope: SessionScope): Effect.Effect<void, AuthorizationFailure> =>
    Effect.suspend(() =>
      sessions.ensureProjected(scope)
        ? Effect.void
        : Effect.fail(
            new AuthorizationFailure({
              message: `Pi session ${scope.identity.key} changed while the Chrome operation was running`,
            }),
          ),
    );

  const ensureToolAdmission = (
    authorizationClaim: AuthorizedSessionClaim,
    connectorClaim: RunConnectorClaim,
  ): Effect.Effect<void, AuthorizationFailure> =>
    ensureSessionScope(authorizationClaim.scope).pipe(
      Effect.flatMap(() =>
        sessions.validatesAuthorizedClaim(authorizationClaim, now()) &&
        runConnectors.validates(connectorClaim)
          ? Effect.void
          : Effect.fail(
              new AuthorizationFailure({
                message: "Chrome authorization or run connector changed before tool admission",
              }),
            ),
      ),
    );

  const poisonAuthorization = (
    scope: SessionScope,
    background: boolean,
  ): Effect.Effect<void, never, NodeServices> =>
    Effect.sync(() => {
      const poisoned = sessions.poison(scope, background);
      if (poisoned) {
        cancelExpiry();
        deactivateTools();
      }
      return poisoned;
    }).pipe(
      Effect.flatMap((poisoned) =>
        poisoned ? refreshStatus(scope.context, scope.epoch) : Effect.void,
      ),
      Effect.andThen(cleanupSessionTarget(scope)),
    );

  const mutateAuthorizationUnlocked = (
    scope: SessionScope,
    mutation: SessionAuthorizationMutation,
  ): Effect.Effect<boolean, AuthorizationFailure, NodeServices> =>
    activeAuthorizationState(scope).pipe(
      Effect.flatMap((authorization) => {
        const applied = Effect.try({
          try: () => sessions.applyAuthorizationMutation(scope, mutation),
          catch: (cause) =>
            new AuthorizationFailure({
              message: `Failed to persist Chrome authorization in the Pi session ledger: ${messageOf(cause)}`,
            }),
        }).pipe(Effect.tapError(() => poisonAuthorization(scope, authorization.background)));
        return applied.pipe(
          Effect.flatMap((result) => {
            if (result._tag === "Applied") return Effect.succeed(result.changed);
            return Effect.fail(
              new AuthorizationFailure({
                message:
                  result._tag === "Poisoned"
                    ? "Chrome authorization ledger became fail-closed before the mutation was applied"
                    : `Pi session ${scope.identity.key} changed before Chrome authorization was mutated`,
              }),
            );
          }),
        );
      }),
    );

  const lockUnlocked = (
    scope: SessionScope,
    cleanupTarget = true,
  ): Effect.Effect<void, AuthorizationFailure, NodeServices> =>
    mutateAuthorizationUnlocked(scope, { _tag: "Lock" }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          cancelExpiry();
          deactivateTools();
        }).pipe(Effect.andThen(refreshStatus(scope.context, scope.epoch))),
      ),
      Effect.flatMap(() => (cleanupTarget ? cleanupSessionTarget(scope) : Effect.void)),
    );

  const lockThrough = <A, E, R>(
    scope: SessionScope,
    operation: () => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, AuthorizationFailure | E, NodeServices | R> =>
    authorizationTransitions.withPermits(1)(
      lockUnlocked(scope, false).pipe(
        Effect.andThen(ensureSessionScope(scope)),
        Effect.andThen(Effect.suspend(operation)),
      ),
    );

  const repairOrLock = (
    scope: SessionScope,
  ): Effect.Effect<void, AuthorizationFailure, NodeServices> =>
    authorizationTransitions.withPermits(1)(
      Effect.suspend(() => {
        const access = sessions.authorizationState(scope, now());
        if (access._tag === "Stale") {
          return Effect.fail(
            new AuthorizationFailure({
              message: `Pi session ${scope.identity.key} changed before Chrome authorization was repaired`,
            }),
          );
        }
        if (access._tag === "Active") return lockUnlocked(scope);
        const background = access.background;
        return Effect.try({
          try: () =>
            AuthorizationOwner.repairLocked({
              append: appendAuthorizationEntry,
              background,
            }),
          catch: (cause) =>
            new AuthorizationFailure({
              message: `Failed to repair Chrome authorization in the Pi session ledger: ${messageOf(cause)}`,
            }),
        }).pipe(
          Effect.tap((owner) =>
            Effect.sync(() => {
              sessions.publishRepaired(scope, owner);
              cancelExpiry();
              deactivateTools();
            }).pipe(Effect.andThen(refreshStatus(scope.context, scope.epoch))),
          ),
          Effect.tapError(() => poisonAuthorization(scope, background)),
          Effect.flatMap(() => cleanupSessionTarget(scope)),
        );
      }),
    );

  const scheduleExpiry = (scope: SessionScope): void => {
    cancelExpiry();
    const snapshot = sessions.snapshot(now());
    if (!sessions.matches(scope) || snapshot._tag !== "Active") return;
    const claim = snapshot.expiry;
    if (!claim) return;
    const delay = Math.max(0, claim.deadline - now());
    expiryFiber = effectRuntime.runFork(
      provideNode(
        Effect.sleep(`${delay} millis`).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.flatMap((currentTime) =>
            authorizationTransitions.withPermits(1)(
              Effect.suspend(() =>
                !sessions.matches(scope)
                  ? Effect.succeed(false)
                  : mutateAuthorizationUnlocked(scope, {
                      _tag: "Expire",
                      claim,
                      now: currentTime,
                    }),
              ).pipe(
                Effect.tap((expired) =>
                  expired
                    ? Effect.sync(() => deactivateTools()).pipe(
                        Effect.andThen(refreshStatus(scope.context, scope.epoch)),
                      )
                    : Effect.void,
                ),
                Effect.flatMap((expired) =>
                  expired
                    ? cleanupSessionTarget(scope).pipe(Effect.as(true))
                    : Effect.succeed(false),
                ),
              ),
            ),
          ),
          Effect.catch((error) =>
            sessions.matches(scope)
              ? Effect.sync(() => deactivateTools()).pipe(
                  Effect.andThen(refreshStatus(scope.context, scope.epoch)),
                  Effect.andThen(
                    Effect.sync(() => scope.context.ui.notify(error.message, "error")),
                  ),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
      ),
    );
  };

  const makeSession = (scope: SessionScope, background: boolean): SessionContext => ({
    ...scope.identity,
    foreground: !background,
  });

  const admitTool = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const scope = yield* requireSessionScope(ctx);
      const authorization = yield* activeAuthorizationState(scope);
      const currentTime = now();
      if (!authorization.authorized) {
        return yield* new AuthorizationFailure({
          message: "Chrome control is locked. Run /chrome authorize first.",
        });
      }
      const claim = sessions.claimAuthorized(scope, currentTime);
      const connectorClaim = runConnectors.claim(scope);
      if (!claim || !connectorClaim) {
        return yield* new AuthorizationFailure({
          message: "Chrome authorization or run connector is not active for this agent run",
        });
      }
      return {
        scope,
        claim: {
          authorizationClaim: claim,
          connectorClaim,
          background: claim.background,
        },
      };
    });

  const executeTool = (
    toolName: string,
    input: unknown,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult> =>
    run(
      executeChromeTool(
        {
          admit: admitTool,
          send: ({ authorizationClaim, connectorClaim }, request, session, timeoutMs) =>
            sendWithConnector(
              connectorClaim.selection,
              Effect.suspend(() => ensureToolAdmission(authorizationClaim, connectorClaim)),
              request,
              session,
              timeoutMs,
            ),
        },
        toolName,
        input,
        ctx,
      ),
      signal,
    );

  const enableToolProfile = (
    profile: AdvancedChromeProfile,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ToolResult> =>
    run(
      Effect.gen(function* () {
        const { claim } = yield* admitTool(ctx);
        yield* ensureToolAdmission(claim.authorizationClaim, claim.connectorClaim);
        return yield* Effect.sync(() => {
          const previous = pi.getActiveTools();
          const active = enableChromeProfile(previous, profile);
          const enabled = active.filter((name) => !previous.includes(name));
          pi.setActiveTools(active);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  enabled.length === 0
                    ? `Chrome ${profile} capabilities are already enabled.`
                    : `Enabled Chrome ${profile} capabilities: ${enabled.join(", ")}`,
              },
            ],
            details: { profile, enabled, active },
          } satisfies ToolResult;
        });
      }),
      signal,
    );

  const authorizationSummary = (): string => {
    const snapshot = sessions.snapshot(now());
    if (snapshot._tag === "Poisoned") return "ledger-error";
    const authorization = snapshot._tag === "Active" ? snapshot.authorization : undefined;
    if (!authorization || authorization.state === "locked") return "locked";
    if (authorization.state === "indefinite") return "indefinite";
    const remaining = authorization.deadline - now();
    return remaining > 0 ? `${Math.ceil(remaining / 60_000)}m` : "expired";
  };

  const renderTerminalStatus = (
    ctx: ExtensionContext,
    status: ChromeStatusProjection,
    currentTime: number,
  ): string => {
    const visual =
      status.readiness === "ready"
        ? { color: "success" as const, label: "Chrome" }
        : status.readiness === "offline"
          ? { color: "warning" as const, label: "Chrome offline" }
          : status.readiness === "locked"
            ? { color: "dim" as const, label: "Chrome locked" }
            : { color: "error" as const, label: "Chrome error" };
    const remaining =
      typeof status.authorization === "object"
        ? ` · ${Math.max(0, Math.ceil((status.authorization.expiresAt - currentTime) / 60_000))}m`
        : "";
    return `${ctx.ui.theme.fg(visual.color, "●")} ${visual.label}${remaining}`;
  };

  const publishStatus = (
    ctx: ExtensionContext,
    status: ChromeStatusProjection,
    currentTime: number,
  ): void => {
    const ui = ctx.ui as StructuredStatusUi;
    if (typeof ui.setStructuredStatus === "function") {
      ui.setStructuredStatus("chrome", status);
      return;
    }
    ctx.ui.setStatus("chrome", renderTerminalStatus(ctx, status, currentTime));
  };

  const clearStatus = (ctx: ExtensionContext): void => {
    const ui = ctx.ui as StructuredStatusUi;
    if (typeof ui.setStructuredStatus === "function") ui.setStructuredStatus("chrome", undefined);
    ctx.ui.setStatus("chrome", undefined);
  };

  const refreshStatus = (
    ctx: ExtensionContext,
    epoch: number,
  ): Effect.Effect<void, never, NodeServices> =>
    Effect.gen(function* () {
      const bridgeSnapshot = yield* bridge.status.pipe(
        Effect.map((status): BridgeStatusSnapshot => ({ _tag: "Available", status })),
        Effect.catch((error) =>
          Effect.succeed<BridgeStatusSnapshot>({ _tag: "Error", message: messageOf(error) }),
        ),
      );
      const currentTime = yield* Clock.currentTimeMillis;
      const session = sessions.snapshot(currentTime);
      if (session.epoch !== epoch) return;
      const id = ctx.sessionManager.getSessionId?.()?.trim();
      const status = projectChromeStatus(
        session,
        bridgeSnapshot,
        currentTime,
        EXTENSION_PATH,
        id ? `session:${id}` : undefined,
      );
      yield* Effect.sync(() => publishStatus(ctx, status, currentTime));
    });

  const startStatusRefresh = (scope: SessionScope): void => {
    cancelStatusRefresh();
    if (typeof (scope.context.ui as StructuredStatusUi).setStructuredStatus !== "function") return;
    statusFiber = effectRuntime.runFork(
      provideNode(
        refreshStatus(scope.context, scope.epoch).pipe(
          Effect.repeat({ schedule: Schedule.spaced("5 seconds") }),
        ),
      ),
    );
  };

  const restoreAuthorizationProjection = (
    epoch: number,
    ctx: ExtensionContext,
    retiredConnectors: ReadonlyArray<RunConnectorSelection>,
  ) =>
    Effect.gen(function* () {
      const identity = yield* resolveSessionIdentity(ctx);
      const admission = yield* Effect.sync(() => sessions.admit(epoch, ctx, identity));
      if (!admission) return;
      const { scope } = admission;
      if (!runConnectors.admit(scope)) {
        return yield* new AuthorizationFailure({
          message: `Pi session ${identity.key} could not acquire Chrome run connector ownership`,
        });
      }
      const bridgeStatus = yield* bridge.status;
      const persistedRoute = bridgeStatus.sessionRoutes.find(
        ({ sessionKey }) => sessionKey === identity.key,
      );
      if (persistedRoute) {
        const restored = runConnectors.restoreWeb(scope, persistedRoute);
        if (!restored) {
          return yield* new AuthorizationFailure({
            message: `Pi session ${identity.key} could not restore its Chrome connector binding`,
          });
        }
      } else if (bridgeStatus.binding && ctx.mode !== "rpc") {
        const attached = runConnectors.attachTerminal(scope, bridgeStatus.binding.connectorId);
        if (!attached) {
          return yield* new AuthorizationFailure({
            message: `Pi session ${identity.key} could not attach the terminal Chrome connector`,
          });
        }
      }
      if (admission.retained && admission.retained.identity.key !== identity.key) {
        yield* cleanupSessionTarget(admission.retained, retiredConnectors[0]);
      }
      if (!sessions.matches(scope)) return;
      const poisoned = yield* Effect.sync(() => sessions.projectPoison(scope));
      if (poisoned) {
        yield* refreshStatus(ctx, scope.epoch);
        yield* Effect.sync(() => {
          ctx.ui.notify(
            "Chrome authorization remains fail-closed after a partial ledger append. Run /chrome revoke to repair a durable lock.",
            "error",
          );
          startStatusRefresh(scope);
        });
        return;
      }
      const restored = yield* Effect.try({
        try: () =>
          restoreAuthorizationOwnerFromSession({
            session: ctx.sessionManager,
            append: appendAuthorizationEntry,
            now: now(),
          }),
        catch: (cause) =>
          new AuthorizationFailure({
            message: `Failed to restore Chrome authorization from the Pi session ledger: ${messageOf(cause)}`,
          }),
      }).pipe(Effect.tapError(() => poisonAuthorization(scope, false)));
      if (!sessions.publishRestored(scope, restored.owner)) return;
      if (restored.reason === "invalid" || restored.reason === "missing") {
        yield* Effect.sync(() =>
          ctx.ui.notify(
            restored.reason === "invalid"
              ? "The latest Chrome authorization entry is invalid; Chrome control was locked."
              : "The current branch has no Chrome authorization entry; Chrome control was locked.",
            "warning",
          ),
        );
      }
      if (isAuthorized()) {
        activateTools();
        scheduleExpiry(scope);
      } else {
        deactivateTools();
      }
      yield* refreshStatus(ctx, scope.epoch);
      yield* Effect.sync(() => startStatusRefresh(scope));
    }).pipe(
      Effect.tapError((error) =>
        sessions.snapshot(now()).epoch === epoch
          ? Effect.sync(() => deactivateTools()).pipe(
              Effect.andThen(refreshStatus(ctx, epoch)),
              Effect.andThen(Effect.sync(() => ctx.ui.notify(error.message, "error"))),
            )
          : Effect.void,
      ),
    );

  const activateSession = (
    epoch: number,
    ctx: ExtensionContext,
    retiredConnectors: ReadonlyArray<RunConnectorSelection>,
  ) =>
    bridge.start.pipe(
      Effect.andThen(
        authorizationTransitions.withPermits(1)(
          restoreAuthorizationProjection(epoch, ctx, retiredConnectors),
        ),
      ),
    );

  pi.on("session_start", (_event, ctx) => {
    const { epoch, connectors } = beginSessionTransition();
    return run(sessionTransitions.withPermits(1)(activateSession(epoch, ctx, connectors)));
  });

  pi.on("session_tree", (_event, ctx) => {
    const { epoch, connectors } = beginSessionTransition();
    return run(sessionTransitions.withPermits(1)(activateSession(epoch, ctx, connectors)));
  });

  pi.on("session_shutdown", (event) => {
    const { previous, connectors } = beginSessionTransition();
    return run(
      sessionTransitions.withPermits(1)(
        authorizationTransitions
          .withPermits(1)(
            Effect.gen(function* () {
              if (previous && event?.reason !== "reload") {
                yield* cleanupSessionTarget(previous, connectors[0]);
              }
              registrations.delete(pi as object);
              deactivateTools();
            }),
          )
          .pipe(Effect.ensuring(bridge.stop)),
      ),
    );
  });

  pi.on("before_agent_start", (event, ctx) =>
    run(
      connectorTransitions.withPermits(1)(
        Effect.gen(function* () {
          const scope = yield* requireSessionScope(ctx);
          const authorization = yield* activeAuthorizationState(scope);
          if (!authorization.authorized) return undefined;

          const activation = runConnectors.activate(scope);
          switch (activation._tag) {
            case "Activated":
              return {
                systemPrompt: `${event.systemPrompt}
<pi-chrome>
Chrome starts with small atomic tools. Call chrome_enable when the task requires an advanced capability profile; the new tools become available immediately.

With no explicit target, work stays in this Pi session's owned automation tab. To use an existing tab, pass exactly one target selector. Call chrome_snapshot before acting and use the returned Action Graph refs. A ref may be passed with or without its leading @. If a ref is stale, take a new snapshot and retry once with the new ref; never guess by role or name. Navigation returns at document commit unless waitUntilLoad is explicitly true. Page evaluation and snapshots use CDP and work under strict CSP. Input uses Chrome's real input layer. Input results keep the action receipt separate from post-action verification; if verification is unavailable, observe again and do not replay the action.
</pi-chrome>`,
              };
            case "Unavailable":
              return yield* new AuthorizationFailure({
                message: `Chrome connector ${activation.connectorId.slice(0, 8)} is attached to this Pi session but its live claim is unavailable. Reopen that exact Chrome profile and pi-web to renew the session binding.`,
              });
            case "Detached":
              return yield* new AuthorizationFailure({
                message:
                  "No Chrome connector is attached to this Pi session. Attach one from pi-web or pair a terminal profile before starting the run.",
              });
          }
        }),
      ),
    ),
  );

  pi.on("agent_settled", (_event, ctx) =>
    run(
      connectorTransitions.withPermits(1)(
        requireSessionScope(ctx).pipe(
          Effect.flatMap((scope) =>
            Effect.sync(() => {
              runConnectors.settle(scope);
            }),
          ),
        ),
      ),
    ),
  );

  const notify = (
    ctx: ExtensionContext,
    text: string,
    level: "info" | "warning" | "error" = "info",
  ) => Effect.sync(() => ctx.ui.notify(text, level));

  const statusProgram = (scope: SessionScope) =>
    bridge.status.pipe(
      Effect.flatMap((status) =>
        ensureSessionScope(scope).pipe(
          Effect.andThen(
            notify(
              scope.context,
              `pi-chrome ${packageJson.version} · bridge ${status.mode} · Chrome ${status.connector?.connected ? "connected" : status.binding ? "paired, offline" : "not paired"} · auth ${authorizationSummary()} · background ${backgroundEnabled() ? "on" : "off"}`,
            ),
          ),
        ),
      ),
    );

  const authorizeProgram = (scope: SessionScope, request: AuthorizationRequest) =>
    Effect.gen(function* () {
      const authorization: Exclude<Authorization, { readonly state: "locked" }> =
        request._tag === "Indefinite"
          ? { state: "indefinite" }
          : {
              state: "timed",
              deadline: (yield* Clock.currentTimeMillis) + request.minutes * 60_000,
            };
      yield* authorizationTransitions.withPermits(1)(
        mutateAuthorizationUnlocked(scope, { _tag: "Authorize", authorization }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              activateTools();
              scheduleExpiry(scope);
              pi.sendMessage(
                {
                  customType: "pi-chrome-tool-change",
                  content: "Chrome tools enabled by /chrome authorize.",
                  display: true,
                  details: {
                    action: "authorized",
                    tools: CHROME_DEFAULT_TOOL_NAMES,
                    authorization,
                  },
                },
                { triggerTurn: false },
              );
            }).pipe(Effect.andThen(refreshStatus(scope.context, scope.epoch))),
          ),
        ),
      );
      yield* ensureSessionScope(scope);
      yield* notify(scope.context, `Chrome control authorized: ${authorizationSummary()}.`);
    });

  const doctorProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      const status = yield* bridge.status;
      yield* ensureSessionScope(scope);
      const lines = [`pi-chrome ${packageJson.version}`, `bridge: ${status.mode} ${status.url}`];
      if (!status.binding) {
        lines.push(
          "connector: not paired",
          "run /chrome onboard and confirm in the target profile",
        );
        return yield* notify(scope.context, lines.join("\n"), "warning");
      }
      lines.push(
        `connector: ${status.binding.label} (${status.binding.connectorId.slice(0, 8)})`,
        `extension: ${status.connector?.extensionDisplayVersion ?? status.binding.extensionDisplayVersion} (${status.binding.extensionId})`,
        `protocol: ${status.connector?.protocolFingerprint ?? status.binding.protocolFingerprint}`,
      );
      if (!status.connector?.connected) {
        lines.push(
          "state: paired, offline",
          "open the paired Chrome profile and reload the extension",
        );
        return yield* notify(scope.context, lines.join("\n"), "warning");
      }
      const now = yield* Clock.currentTimeMillis;
      const age = Math.max(0, now - (status.connector.lastSeenAt ?? now));
      lines.push(`state: connected · last seen ${Math.ceil(age / 1_000)}s ago`);
      const session = makeSession(scope, true);
      const connector = yield* requireConnectorSelection(scope);
      const ownedTab = yield* sendWithConnector(
        connector,
        Effect.void,
        { domain: "system", call: { op: "automation-status" } },
        session,
        10_000,
      );
      const targetStatus =
        typeof ownedTab === "object" && ownedTab !== null
          ? (ownedTab as Record<string, unknown>)
          : {};
      const targets = Array.isArray(targetStatus.targets)
        ? targetStatus.targets.filter(
            (target): target is Record<string, unknown> =>
              typeof target === "object" && target !== null,
          )
        : [];
      if (targets.length === 0) {
        lines.push("targets: none");
      } else {
        lines.push(`targets: ${targets.length}`);
        for (const target of targets) {
          const tab =
            typeof target.tab === "object" && target.tab !== null
              ? (target.tab as Record<string, unknown>)
              : {};
          lines.push(
            target.state === "owned"
              ? `target: owned tab ${String(tab.id)}`
              : target.state === "stale"
                ? `target: stale (${String(target.reason)})`
                : "target: allocating",
          );
        }
      }
      const hasStaleTarget = targets.some((target) => target.state === "stale");
      if (hasStaleTarget)
        lines.push(
          "recovery: run /chrome cleanup, then retry the page/input operation to create a new target",
        );
      lines.push(`target details: ${json(ownedTab)}`);
      yield* ensureSessionScope(scope);
      yield* notify(scope.context, lines.join("\n"), hasStaleTarget ? "warning" : "info");
    });

  const cleanupProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      const session = makeSession(scope, true);
      const connector = yield* requireConnectorSelection(scope);
      const result = yield* sendWithConnector(
        connector,
        Effect.void,
        { domain: "system", call: { op: "cleanup" } },
        session,
        10_000,
      );
      yield* ensureSessionScope(scope);
      yield* notify(
        scope.context,
        `Chrome target cleanup: ${json(result)}\nThe next implicit page/input operation can create a new session target.`,
      );
    });

  const onboardProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      const ctx = scope.context;
      const proceed = yield* Effect.tryPromise({
        try: () =>
          ctx.ui.confirm(
            "Install the pi-chrome Chrome extension?",
            `Load this unpacked extension folder in chrome://extensions:\n${EXTENSION_PATH}`,
          ),
        catch: (cause) => new AuthorizationFailure({ message: messageOf(cause) }),
      });
      if (!proceed) return;
      yield* ensureSessionScope(scope);
      const pairing = yield* bridge.beginPairing();
      yield* ensureSessionScope(scope);
      const pairingTimeRemaining = formatPairingTimeRemaining(
        pairing.expiresAt,
        yield* Clock.currentTimeMillis,
      );
      yield* notify(
        ctx,
        `Load or reload the unpacked extension from:\n${EXTENSION_PATH}\n\nOne-time pairing token: ${pairing.challenge}\n\nIn the Chrome profile you want Pi to use, click the Pi Chrome Connector icon and enter this token. Do not enter it in any other profile.\nPairing expires in ${pairingTimeRemaining}.`,
      );
      if (process.platform === "darwin") {
        const openedExtensions = yield* Effect.tryPromise({
          try: () =>
            pi.exec("open", ["-a", "Google Chrome", "chrome://extensions"], {
              cwd: workspaceCwd(ctx),
              timeout: 5_000,
            }),
          catch: (cause) => new AuthorizationFailure({ message: messageOf(cause) }),
        }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        const revealedExtension = yield* Effect.tryPromise({
          try: () =>
            pi.exec("open", ["-R", EXTENSION_PATH], {
              cwd: workspaceCwd(ctx),
              timeout: 5_000,
            }),
          catch: (cause) => new AuthorizationFailure({ message: messageOf(cause) }),
        }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!openedExtensions || !revealedExtension) {
          yield* notify(
            ctx,
            "Pairing is ready, but macOS could not open Chrome or reveal the extension folder automatically. Use the path shown above.",
            "warning",
          );
        }
      }
    });

  const webAttachProgram = (scope: SessionScope, token: string) =>
    connectorTransitions.withPermits(1)(
      Effect.gen(function* () {
        if (!runConnectors.canPrepare(scope)) {
          return yield* new AuthorizationFailure({
            message: "A Chrome connector is already active for this agent run",
          });
        }
        const offer = yield* decodeWebRunOfferToken(token);
        const claim = yield* bridge.stageWebRunLease(offer, scope.identity.key);
        const replaced = yield* Effect.sync(() => runConnectors.prepare(scope, claim));
        if (!replaced) {
          yield* releaseWebLease(scope, claim);
          return yield* new AuthorizationFailure({
            message: "Pi session changed while the web connector lease was staged",
          });
        }
        for (const previous of replaced) {
          yield* releaseWebLease(scope, previous);
        }
      }),
    );

  const webAssertProgram = (scope: SessionScope, pairingId: string) =>
    connectorTransitions.withPermits(1)(
      Effect.gen(function* () {
        const claim = runConnectors.assertPrepared(scope, pairingId);
        if (!claim) {
          return yield* new AuthorizationFailure({
            message: `Web connector lease ${pairingId} is not prepared for the next run`,
          });
        }
        yield* bridge.assertWebRunLease(claim);
        if (!runConnectors.commitPrepared(scope, pairingId)) {
          yield* bridge.detachSessionWebRoute(scope.identity.key, pairingId);
          return yield* new AuthorizationFailure({
            message: `Pi session changed before Chrome connector route ${pairingId} was committed`,
          });
        }
        yield* refreshStatus(scope.context, scope.epoch);
      }),
    );

  const webDetachProgram = (scope: SessionScope, pairingId: string) =>
    connectorTransitions.withPermits(1)(
      Effect.gen(function* () {
        const prepared = runConnectors.assertPrepared(scope, pairingId);
        const route = runConnectors.webRoute(scope);
        if (prepared) {
          const status = yield* bridge.status;
          const replacedRoute = status.sessionRoutes.some(
            (candidate) =>
              candidate.sessionKey === scope.identity.key && candidate.generation === pairingId,
          );
          yield* bridge.releaseWebRunLease(prepared);
          runConnectors.detach(scope, pairingId);
          if (replacedRoute) {
            const staleRoute = runConnectors.webRoute(scope);
            if (staleRoute) runConnectors.detach(scope, staleRoute.generation);
          }
          return;
        }
        if (!route || route.generation !== pairingId) return;
        yield* detachSessionWebRoute(scope, route);
        runConnectors.detach(scope, pairingId);
      }),
    );

  const webTerminalProgram = (scope: SessionScope) =>
    connectorTransitions.withPermits(1)(
      Effect.gen(function* () {
        const status = yield* bridge.status;
        const binding = status.binding;
        if (!binding) {
          return yield* new AuthorizationFailure({
            message: "No terminal Chrome profile is paired. Run /chrome onboard first.",
          });
        }
        const route = runConnectors.webRoute(scope);
        if (route) yield* detachSessionWebRoute(scope, route);
        const retired = runConnectors.selectTerminal(scope, binding.connectorId);
        if (!retired) {
          return yield* new AuthorizationFailure({
            message: "Pi session changed before the terminal Chrome connector was attached",
          });
        }
        for (const claim of retired) {
          if (route?.claim && claim.pairingId === route.claim.pairingId) continue;
          yield* releaseWebLease(scope, claim);
        }
      }),
    );

  const unpairProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      const session = makeSession(scope, true);
      const cleanup = { domain: "system", call: { op: "cleanup-all" } } as const;
      yield* lockThrough(scope, () => bridge.unpair(session, bridgeDeliveryTimeoutMs(cleanup)));
      yield* ensureSessionScope(scope);
      yield* Effect.sync(() => {
        pi.sendMessage(
          {
            customType: "pi-chrome-tool-change",
            content: "Chrome profile unpaired and Chrome tools disabled.",
            display: true,
            details: { action: "unpaired", tools: CHROME_TOOL_NAMES },
          },
          { triggerTurn: false },
        );
      });
      yield* notify(scope.context, "Chrome profile unpaired.");
    });

  const forgetProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      const ctx = scope.context;
      const status = yield* bridge.status;
      yield* ensureSessionScope(scope);
      const binding = status.binding;
      if (!binding) {
        return yield* new AuthorizationFailure({
          message: "No Chrome profile is paired. Run /chrome onboard first.",
        });
      }
      const confirmed = yield* Effect.tryPromise({
        try: () =>
          ctx.ui.confirm(
            "Forget the unreachable Chrome connector?",
            `Connector ${binding.label} (${binding.connectorId.slice(0, 8)}) will be removed without cleanup. No Chrome tabs will be closed. Use this only after the extension identity was lost, then close any old Pi tabs manually.`,
          ),
        catch: (cause) => new AuthorizationFailure({ message: messageOf(cause) }),
      });
      if (!confirmed) return;
      yield* lockThrough(scope, () => bridge.forget(binding.connectorId));
      yield* ensureSessionScope(scope);
      yield* Effect.sync(() => {
        pi.sendMessage(
          {
            customType: "pi-chrome-tool-change",
            content:
              "Unreachable Chrome connector forgotten without cleanup; Chrome tools disabled.",
            display: true,
            details: { action: "forgotten", tools: CHROME_TOOL_NAMES },
          },
          { triggerTurn: false },
        );
      });
      yield* notify(
        ctx,
        "Chrome connector forgotten. No tabs were closed; close any old Pi tabs manually before onboarding another profile.",
        "warning",
      );
    });

  const revokeProgram = (scope: SessionScope) =>
    Effect.gen(function* () {
      yield* repairOrLock(scope);
      yield* connectorTransitions.withPermits(1)(
        Effect.gen(function* () {
          const route = runConnectors.webRoute(scope);
          if (!route) return;
          yield* detachSessionWebRoute(scope, route);
          runConnectors.detach(scope, route.generation);
        }),
      );
      yield* ensureSessionScope(scope);
      yield* Effect.sync(() => {
        pi.sendMessage(
          {
            customType: "pi-chrome-tool-change",
            content: "Chrome tools disabled by /chrome revoke.",
            display: true,
            details: { action: "revoked", tools: CHROME_TOOL_NAMES },
          },
          { triggerTurn: false },
        );
        scope.context.ui.notify("Chrome control locked.", "info");
      });
    });

  const setBackgroundProgram = (scope: SessionScope, enabled: boolean) =>
    authorizationTransitions.withPermits(1)(
      mutateAuthorizationUnlocked(scope, { _tag: "SetBackground", background: enabled }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            scheduleExpiry(scope);
            scope.context.ui.notify(
              `Background mode ${backgroundEnabled() ? "on" : "off"}.`,
              "info",
            );
          }),
        ),
        Effect.asVoid,
      ),
    );

  const interpretChromeCommand = (
    scope: SessionScope,
    command: ChromeCommand,
  ): Effect.Effect<void, unknown, NodeServices> => {
    switch (command._tag) {
      case "Authorize":
        return authorizeProgram(scope, command.authorization);
      case "Revoke":
        return revokeProgram(scope);
      case "Status":
        return statusProgram(scope);
      case "Doctor":
        return doctorProgram(scope);
      case "Cleanup":
        return cleanupProgram(scope);
      case "Onboard":
        return onboardProgram(scope);
      case "Unpair":
        return unpairProgram(scope);
      case "Forget":
        return forgetProgram(scope);
      case "WebAttach":
        return webAttachProgram(scope, command.offer);
      case "WebAssert":
        return webAssertProgram(scope, command.pairingId);
      case "WebDetach":
        return webDetachProgram(scope, command.pairingId);
      case "WebTerminal":
        return webTerminalProgram(scope);
      case "SetBackground":
        return setBackgroundProgram(scope, command.enabled);
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  };

  pi.registerCommand("chrome", {
    description:
      "Manage pi-chrome: authorize, revoke, status, doctor, cleanup, onboard, unpair, forget, or background.",
    getArgumentCompletions: chromeCommandCompletions,
    handler: (args, ctx) =>
      run(
        parseChromeCommand(args).pipe(
          Effect.flatMap((command) =>
            requireSessionScope(ctx).pipe(
              Effect.flatMap((scope) => interpretChromeCommand(scope, command)),
            ),
          ),
        ),
      ),
  });
}
