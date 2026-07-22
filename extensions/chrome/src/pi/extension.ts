import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import {
  structuredView,
  webSurface,
  withCompanionView,
  withConversationView,
  type WebSurfaceSlot,
} from "@pipee/extension-kit";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import { ChromeUnavailable, messageOf } from "../core/errors.js";
import { BRIDGE_HOST, BRIDGE_PORT } from "../protocol/bridge-contract.js";
import { FormattedTabResult } from "../protocol/operation-schemas.js";
import type { SessionContext } from "../protocol/schema.js";
import { NodeBridge } from "./node-bridge.js";
import { projectSessionGroupTitle } from "./session-group-title.js";
import { executeChromeTool, type ChromeToolScope } from "./tool-execution.js";
import {
  projectChromeStatus,
  type BridgeStatusSnapshot,
  type ChromeStatusProjection,
} from "./status-projection.js";
import { registerChromeTools, type ToolResult } from "./tools.js";
import { projectChromeCompanionView, projectChromeConversationView } from "./conversation-view.js";
import {
  ChromeWebAction,
  projectChromeWebView,
  type ChromeWebReceipt,
  type ChromeWebTab,
  type ChromeWebActivity,
  type ChromeWebEvent,
} from "./web-surface.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../dist/browser-extension/", import.meta.url));
const registrations = new WeakSet<object>();
const effectRuntime = ManagedRuntime.make(Layer.empty);

const provideNode = <A, E>(effect: Effect.Effect<A, E, NodeServices>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));

const makeBridge = (): NodeBridge => {
  return effectRuntime.runSync(
    NodeBridge.make(BRIDGE_HOST, BRIDGE_PORT, () => packageJson.version),
  );
};

const resolveSessionIdentity = (
  context: ExtensionContext,
): Effect.Effect<ChromeToolScope["identity"], ChromeUnavailable> =>
  Effect.suspend(() => {
    const id = context.sessionManager.getSessionId?.()?.trim();
    if (!id) {
      return Effect.fail(new ChromeUnavailable({ message: "Pi session id is unavailable" }));
    }
    const name = context.sessionManager.getSessionName?.()?.trim();
    return Effect.succeed({
      key: `session:${id}`,
      groupTitle: projectSessionGroupTitle(id, name, context.sessionManager.getBranch()),
    });
  });

export default function piChrome(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  const bridge = makeBridge();
  const sessionTransitions = Semaphore.makeUnsafe(1);
  let activeScope: ChromeToolScope | undefined;
  let statusFiber: Fiber.Fiber<void, never> | undefined;
  let webScope: Scope.Closeable | undefined;
  let surface: WebSurfaceSlot | undefined;
  let latestStatus: ChromeStatusProjection | undefined;
  let tabs: ReadonlyArray<ChromeWebTab> = [];
  let receipts: ReadonlyArray<ChromeWebReceipt> = [];
  let activity: ChromeWebActivity | null = null;
  let events: ReadonlyArray<ChromeWebEvent> = [];
  let activitySequence = 0;
  let currentToolAbort: AbortController | undefined;

  const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>, signal?: AbortSignal): Promise<A> =>
    effectRuntime.runPromise(provideNode(effect), signal ? { signal } : undefined);

  const runDetached = <A, E>(effect: Effect.Effect<A, E, NodeServices>): void => {
    effectRuntime.runFork(provideNode(effect));
  };

  const sameScope = (scope: ChromeToolScope): boolean =>
    activeScope?.identity.key === scope.identity.key && activeScope.context === scope.context;

  const requireScope = (context: ExtensionContext) =>
    resolveSessionIdentity(context).pipe(
      Effect.flatMap((identity) =>
        Effect.suspend(() => {
          const scope = activeScope;
          return scope && scope.identity.key === identity.key
            ? Effect.succeed(scope)
            : Effect.fail(
                new ChromeUnavailable({
                  message: `Pi session ${identity.key} is not the active Chrome session`,
                }),
              );
        }),
      ),
    );

  const bridgeSnapshot: Effect.Effect<BridgeStatusSnapshot, never, NodeServices> =
    bridge.status.pipe(
      Effect.map((status): BridgeStatusSnapshot => ({ _tag: "Available", status })),
      Effect.catch((error) =>
        Effect.succeed({ _tag: "Error", message: messageOf(error) } satisfies BridgeStatusSnapshot),
      ),
    );

  const publishStatus = (scope: ChromeToolScope, status: ChromeStatusProjection) =>
    Effect.sync(() => {
      if (!sameScope(scope)) return;
      latestStatus = status;
      structuredView(scope.context.ui, packageJson.name)?.replace(
        "chrome",
        withCompanionView(status, projectChromeCompanionView(status)),
      );
      surface?.replace(projectChromeWebView(status, tabs, receipts, activity, events));
      const label =
        status.state === "ready"
          ? "Chrome ready"
          : status.state === "waiting-for-extension"
            ? "Chrome waiting"
            : status.state === "offline"
              ? "Chrome offline"
              : "Chrome error";
      scope.context.ui.setStatus("chrome", label);
    });

  const refreshStatus = (scope: ChromeToolScope) =>
    bridgeSnapshot.pipe(
      Effect.map((snapshot) => projectChromeStatus(snapshot, EXTENSION_PATH)),
      Effect.flatMap((status) => publishStatus(scope, status)),
    );

  const stopStatusRefresh = (): void => {
    const current = statusFiber;
    statusFiber = undefined;
    if (current) runDetached(Fiber.interrupt(current));
  };

  const startStatusRefresh = (scope: ChromeToolScope): void => {
    stopStatusRefresh();
    statusFiber = effectRuntime.runFork(
      provideNode(
        refreshStatus(scope).pipe(
          Effect.andThen(
            refreshTabs(scope).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Chrome Web Surface tab refresh failed", { error }),
              ),
            ),
          ),
          Effect.andThen(Effect.sleep("2 seconds")),
          Effect.repeat(Schedule.forever),
          Effect.asVoid,
        ),
      ),
    );
  };

  const admitTool = (context: ExtensionContext) =>
    Effect.gen(function* () {
      const scope = yield* requireScope(context);
      yield* bridge.awaitReady(8_000);
      yield* requireScope(context);
      return { scope, claim: { background: false } };
    });

  const executeToolEffect = (toolName: string, input: unknown, context: ExtensionContext) =>
    executeChromeTool(
      {
        admit: admitTool,
        send: (_claim, request, session, timeoutMs) =>
          bridge.sendGuarded(
            requireScope(context).pipe(Effect.asVoid),
            request,
            session,
            timeoutMs,
          ),
      },
      toolName,
      input,
      context,
    );

  const publishWebSurface = () => {
    if (latestStatus)
      surface?.replace(projectChromeWebView(latestStatus, tabs, receipts, activity, events));
  };

  const executeTool = (
    toolName: string,
    input: unknown,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<ToolResult> => {
    const sequence = ++activitySequence;
    const controller = new AbortController();
    currentToolAbort = controller;
    const combinedSignal =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
    const monitored = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        activity = { operation: toolName, startedAt };
        events = [
          { at: startedAt, operation: toolName, phase: "started" } satisfies ChromeWebEvent,
          ...events,
        ].slice(0, 60);
        publishWebSurface();
      });
      const result = yield* executeToolEffect(toolName, input, context);
      const completedAt = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => {
        events = [
          { at: completedAt, operation: toolName, phase: "completed" } satisfies ChromeWebEvent,
          ...events,
        ].slice(0, 60);
        receipts = [
          {
            at: completedAt,
            operation: toolName,
            result: "completed",
            evidence:
              toolName === "chrome_snapshot"
                ? "Action Graph"
                : toolName === "chrome_screenshot"
                  ? "JPEG"
                  : "Receipt",
          },
          ...receipts,
        ].slice(0, 20);
      });
      return result;
    }).pipe(
      Effect.tapError((error) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((failedAt) =>
            Effect.sync(() => {
              events = [
                {
                  at: failedAt,
                  operation: toolName,
                  phase: "failed",
                  message: messageOf(error),
                } satisfies ChromeWebEvent,
                ...events,
              ].slice(0, 60);
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (sequence !== activitySequence) return;
          activity = null;
          currentToolAbort = undefined;
          publishWebSurface();
        }),
      ),
    );
    return run(monitored, combinedSignal);
  };

  const refreshTabs = (scope: ChromeToolScope) =>
    Effect.gen(function* () {
      if (latestStatus?.state !== "ready" || !sameScope(scope)) {
        tabs = [];
        publishWebSurface();
        return;
      }
      const result = yield* executeToolEffect("chrome_tab_list", {}, scope.context);
      tabs = yield* Schema.decodeUnknownEffect(Schema.Array(FormattedTabResult))(
        result.details.value,
      );
      if (latestStatus && sameScope(scope)) {
        publishWebSurface();
      }
    });

  const dispatchSurfaceAction = (scope: ChromeToolScope, payload: unknown) =>
    Schema.decodeUnknownEffect(ChromeWebAction)(payload).pipe(
      Effect.flatMap((action) => {
        if (action._tag === "Terminate") {
          currentToolAbort?.abort();
          return Effect.void;
        }
        const target = { by: "id" as const, value: action.tabId };
        return executeToolEffect("chrome_tab_close", { target }, scope.context).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.tap((at) =>
            Effect.sync(() => {
              receipts = [
                {
                  at,
                  operation: "chrome_tab_close",
                  tabId: action.tabId,
                  result: "completed",
                  evidence: "Receipt",
                },
                ...receipts,
              ].slice(0, 20);
            }),
          ),
          Effect.andThen(refreshTabs(scope)),
        );
      }),
      Effect.match({
        onFailure: (error) => ({ _tag: "Failed" as const, message: messageOf(error) }),
        onSuccess: () => ({ _tag: "Accepted" as const, payload: null }),
      }),
    );

  const readStatus = (
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ): Promise<ToolResult> =>
    run(
      Effect.gen(function* () {
        const scope = yield* requireScope(context);
        const snapshot = yield* bridgeSnapshot;
        const status = projectChromeStatus(snapshot, EXTENSION_PATH);
        yield* publishStatus(scope, status);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
          details: withConversationView({ status }, projectChromeConversationView(status)),
        } satisfies ToolResult;
      }),
      signal,
    );

  const cleanupSessionTarget = (scope: ChromeToolScope) =>
    bridge
      .send(
        { domain: "system", call: { op: "cleanup" } },
        { ...scope.identity, foreground: false } satisfies SessionContext,
        10_000,
      )
      .pipe(
        Effect.catch(() => Effect.void),
        Effect.asVoid,
      );

  const activateSession = (context: ExtensionContext) =>
    Effect.gen(function* () {
      yield* bridge.start;
      const identity = yield* resolveSessionIdentity(context);
      const previous = activeScope;
      const scope = { context, identity } satisfies ChromeToolScope;
      activeScope = scope;
      if (webScope) yield* Scope.close(webScope, Exit.succeed(undefined));
      const nextWebScope = yield* Scope.make("sequential");
      webScope = nextWebScope;
      if (previous && previous.identity.key !== scope.identity.key) {
        yield* cleanupSessionTarget(previous);
      }
      yield* refreshStatus(scope);
      surface = yield* webSurface(context.ui, packageJson.name, (request, signal) =>
        run(dispatchSurfaceAction(scope, request.payload), signal),
      ).pipe(Effect.provideService(Scope.Scope, nextWebScope));
      if (latestStatus)
        surface.replace(projectChromeWebView(latestStatus, tabs, receipts, activity, events));
      yield* refreshTabs(scope);
      yield* Effect.sync(() => startStatusRefresh(scope));
    });

  registerChromeTools(pi, executeTool, readStatus);

  pi.on("session_start", (_event, context) =>
    run(sessionTransitions.withPermits(1)(activateSession(context))),
  );

  pi.on("session_tree", (_event, context) =>
    run(sessionTransitions.withPermits(1)(activateSession(context))),
  );

  pi.on("session_shutdown", (event) =>
    run(
      sessionTransitions.withPermits(1)(
        Effect.gen(function* () {
          const scope = activeScope;
          activeScope = undefined;
          stopStatusRefresh();
          if (webScope) yield* Scope.close(webScope, Exit.succeed(undefined));
          webScope = undefined;
          surface = undefined;
          latestStatus = undefined;
          tabs = [];
          receipts = [];
          activity = null;
          events = [];
          currentToolAbort?.abort();
          currentToolAbort = undefined;
          if (scope && event?.reason !== "reload") yield* cleanupSessionTarget(scope);
          yield* bridge.stop;
          registrations.delete(pi as object);
        }),
      ),
    ),
  );
}
