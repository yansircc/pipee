import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import {
  livePresentation,
  webSurface,
  withPresentation,
  type WebSurfaceSlot,
} from "@pipee/extension-kit";
import { Clock, Data, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import { externalCheckSummary, runExternalCheck, type ExternalCheck } from "../domain/checker.js";
import {
  ZeroYConnectionConfigError,
  connectionFor,
  loadSiteConnections,
  type SiteConnection,
} from "../domain/connection.js";
import { ZeroYConnectorError, connectorGet, connectorPost } from "../domain/client.js";
import {
  ContentApplyParameters,
  InspectParameters,
  ThemeApplyParameters,
  type ContentApplyInput,
  type InspectInput,
  type JsonRecord,
  type ThemeApplyInput,
} from "../domain/protocol.js";
import { zeroYPresentation } from "./presentation.js";
import { failedSiteView, projectZeroYWebView, type ZeroYSiteView } from "./web-surface.js";

const runtime = ManagedRuntime.make(Layer.empty);
const registrations = new WeakSet<object>();

type ActiveSession = {
  readonly context: ExtensionContext;
  readonly scope: Scope.Closeable;
  readonly connections: ReadonlyArray<SiteConnection>;
  readonly presentation: LivePresentationPort | undefined;
  readonly surface: WebSurfaceSlot;
  readonly externalChecks: Map<string, ExternalCheck>;
};

class ZeroYSessionUnavailable extends Data.TaggedError("ZeroYSessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, ActiveSession>();
const emptySurface: WebSurfaceSlot = { replace: () => undefined };

const text = (value: unknown): string => JSON.stringify(value, null, 2);
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const result = (
  content: string,
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  tone: "success" | "info" | "warning" | "danger" = "success",
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: content }],
  details: withPresentation({}, zeroYPresentation(title, summary, fields, tone)),
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => runtime.runPromise(effect);

const runTool = (
  effect: Effect.Effect<
    AgentToolResult<unknown>,
    ZeroYConnectorError | ZeroYConnectionConfigError | ZeroYSessionUnavailable
  >,
): Promise<AgentToolResult<unknown>> =>
  run(
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed(
          result(
            errorMessage(error),
            "zeroY Connector",
            "Request failed",
            [["Error", errorMessage(error)]],
            "danger",
          ),
        ),
      ),
    ),
  );

const notifySessionFailure = (context: ExtensionContext, error: unknown) =>
  Effect.sync(() => {
    if (context.hasUI) context.ui.notify(`zeroY: ${errorMessage(error)}`, "error");
  });

const withSession = <A, E>(
  pi: ExtensionAPI,
  use: (active: ActiveSession) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ZeroYSessionUnavailable> =>
  Effect.gen(function* () {
    const active = sessions.get(pi as object);
    if (!active) {
      return yield* new ZeroYSessionUnavailable({
        message:
          "zeroY session is unavailable. Configure ZEROY_SITES before creating the Pipee session.",
      });
    }
    return yield* use(active);
  });

const connection = (
  active: ActiveSession,
  siteId: string,
): Effect.Effect<SiteConnection, ZeroYConnectionConfigError> => {
  const selected = connectionFor(active.connections, siteId);
  return selected instanceof ZeroYConnectionConfigError
    ? Effect.fail(selected)
    : Effect.succeed(selected);
};

const inspectConnection = (
  active: ActiveSession,
  site: SiteConnection,
): Effect.Effect<ZeroYSiteView, never> =>
  Effect.all(
    [
      connectorGet(site, "site"),
      connectorGet(site, "schema"),
      connectorGet(site, "inventory?page=1&perPage=100"),
      connectorGet(site, "acf"),
      connectorGet(site, "integrity"),
    ],
    { concurrency: 5 },
  ).pipe(
    Effect.flatMap(([siteView, schema, inventory, acf, integrity]) => {
      if (siteView.siteId !== site.siteId) {
        return Effect.fail(
          new ZeroYConnectorError({
            message: `Connection ${site.label} expected siteId ${site.siteId}, but the Connector reported ${String(siteView.siteId)}.`,
          }),
        );
      }
      return Effect.succeed({
        siteId: site.siteId,
        label: site.label,
        endpoint: site.endpoint,
        state: "ready" as const,
        error: null,
        site: siteView,
        schema,
        inventory,
        acf,
        integrity,
        externalCheck: active.externalChecks.get(site.siteId) ?? null,
      });
    }),
    Effect.catch((error) => Effect.succeed(failedSiteView(site, errorMessage(error)))),
  );

const refreshSurface = (active: ActiveSession): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const sites = yield* Effect.forEach(
      active.connections,
      (site) => inspectConnection(active, site),
      {
        concurrency: 4,
      },
    );
    const observedAt = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() =>
      active.surface.replace(projectZeroYWebView(sites, String(observedAt))),
    );
  }).pipe(Effect.withSpan("zeroy.web-surface.refresh"));

const withLivePresentation = <A, E>(
  active: ActiveSession,
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.sync(() =>
    active.presentation?.replace("activity", zeroYPresentation(title, summary, fields)),
  ).pipe(
    Effect.andThen(effect),
    Effect.ensuring(Effect.sync(() => active.presentation?.replace("activity", undefined))),
  );

const stopSession = (pi: ExtensionAPI, active: ActiveSession): Effect.Effect<void> =>
  Scope.close(active.scope, Exit.succeed(undefined)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        active.presentation?.replace("activity", undefined);
        sessions.delete(pi as object);
      }),
    ),
  );

const startSession = (
  pi: ExtensionAPI,
  context: ExtensionContext,
): Effect.Effect<void, ZeroYConnectionConfigError> =>
  Effect.gen(function* () {
    const previous = sessions.get(pi as object);
    if (previous) yield* stopSession(pi, previous);
    const scope = yield* Scope.make("sequential");
    yield* Effect.gen(function* () {
      const connections = yield* loadSiteConnections();
      const surface = yield* webSurface(context.ui, packageJson.name, () => ({
        _tag: "Rejected" as const,
        reason: "zeroY WebSurface is read-only; ask the Agent to make changes in the conversation.",
      })).pipe(
        Effect.catchTag("WebSurfaceCapabilityUnavailable", () => Effect.succeed(emptySurface)),
      );
      const active: ActiveSession = {
        context,
        scope,
        connections,
        presentation: livePresentation(context.ui, packageJson.name),
        surface,
        externalChecks: new Map(),
      };
      yield* Effect.sync(() => sessions.set(pi as object, active));
      yield* refreshSurface(active);
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

const inspectResource = (
  active: ActiveSession,
  input: InspectInput,
  signal: AbortSignal | undefined,
): Effect.Effect<
  { readonly payload: JsonRecord; readonly summary: string },
  ZeroYConnectorError | ZeroYConnectionConfigError
> =>
  Effect.gen(function* () {
    const site = yield* connection(active, input.siteId);
    switch (input.resource) {
      case "site":
        return {
          payload: yield* connectorGet(site, "site", signal),
          summary: "Read site handshake",
        };
      case "schema":
        return {
          payload: yield* connectorGet(site, "schema", signal),
          summary: "Read ThemeSchema",
        };
      case "inventory": {
        const page = input.page ?? 1;
        const perPage = input.perPage ?? 50;
        return {
          payload: yield* connectorGet(site, `inventory?page=${page}&perPage=${perPage}`, signal),
          summary: "Read canonical inventory",
        };
      }
      case "acf":
        return {
          payload: yield* connectorGet(site, "acf", signal),
          summary: "Read shared ACF structure",
        };
      case "themeFiles":
        return {
          payload: yield* connectorGet(
            site,
            input.path ? `theme-files?path=${encodeURIComponent(input.path)}` : "theme-files",
            signal,
          ),
          summary: input.path ? "Read active-theme file" : "Read active-theme file tree",
        };
      case "localeContent":
        return {
          payload: yield* connectorGet(
            site,
            `locale-content?objectId=${input.objectId}&locale=${encodeURIComponent(input.locale)}`,
            signal,
          ),
          summary: "Read locale content",
        };
      case "integrity":
        return {
          payload: yield* connectorGet(site, "integrity", signal),
          summary: "Ran Connector integrity checks",
        };
      case "externalCheck": {
        const inventory = yield* connectorGet(site, "inventory?page=1&perPage=100", signal);
        const check = yield* runExternalCheck(inventory, signal);
        yield* Effect.sync(() => active.externalChecks.set(site.siteId, check));
        yield* refreshSurface(active);
        return {
          payload: { inventory, externalCheck: check },
          summary: `Ran external checks: ${externalCheckSummary(check)}`,
        };
      }
    }
  });

const inspectTool = (active: ActiveSession, input: InspectInput, signal: AbortSignal | undefined) =>
  withLivePresentation(
    active,
    "zeroY inspection",
    "Reading a typed Connector resource",
    [
      ["Site", input.siteId],
      ["Resource", input.resource],
    ],
    inspectResource(active, input, signal).pipe(
      Effect.map(({ payload, summary }) =>
        result(text(payload), "zeroY inspection", summary, [
          ["Site", input.siteId],
          ["Resource", input.resource],
        ]),
      ),
    ),
  );

const themeApplyTool = (
  active: ActiveSession,
  input: ThemeApplyInput,
  signal: AbortSignal | undefined,
) =>
  withLivePresentation(
    active,
    "zeroY theme update",
    "Writing active-theme files with exact hash preconditions",
    [
      ["Site", input.siteId],
      ["Files", String(input.files.length)],
    ],
    Effect.gen(function* () {
      const site = yield* connection(active, input.siteId);
      const payload = yield* connectorPost(site, "theme-files", { files: input.files }, signal);
      yield* refreshSurface(active);
      const complete = payload.ok === true;
      return result(
        text(payload),
        complete ? "zeroY theme updated" : "zeroY theme partially updated",
        complete
          ? "All requested files were atomically replaced."
          : "Some writes failed; successful files remain changed.",
        [
          ["Site", input.siteId],
          ["Files", String(input.files.length)],
        ],
        complete ? "success" : "warning",
      );
    }),
  );

const contentPayload = (
  input: ContentApplyInput,
): { readonly path: string; readonly body: JsonRecord } => {
  switch (input.action) {
    case "siteConfig":
      return {
        path: "site-config",
        body: { siteConfig: input.siteConfig, expectedRevision: input.expectedRevision },
      };
    case "createCanonical":
      return {
        path: "canonical",
        body: {
          action: "create",
          postType: input.postType,
          schemaId: input.schemaId,
          postTitle: input.postTitle ?? "",
        },
      };
    case "assignSchema":
      return {
        path: "canonical",
        body: {
          action: "assignSchema",
          objectId: input.objectId,
          schemaId: input.schemaId,
          expectedRevision: input.expectedRevision,
        },
      };
    case "writeDraft":
      return {
        path: "locale-content",
        body: {
          action: input.action,
          objectId: input.objectId,
          locale: input.locale,
          schemaId: input.schemaId,
          route: input.route,
          document: input.document,
          expectedRevision: input.expectedRevision,
        },
      };
    case "publish":
    case "unpublish":
      return {
        path: "locale-content",
        body: {
          action: input.action,
          objectId: input.objectId,
          locale: input.locale,
          expectedRevision: input.expectedRevision,
        },
      };
  }
};

const contentApplyTool = (
  active: ActiveSession,
  input: ContentApplyInput,
  signal: AbortSignal | undefined,
) =>
  withLivePresentation(
    active,
    "zeroY content update",
    `Applying ${input.action} through the typed content port`,
    [
      ["Site", input.siteId],
      ["Action", input.action],
    ],
    Effect.gen(function* () {
      const site = yield* connection(active, input.siteId);
      const operation = contentPayload(input);
      const payload = yield* connectorPost(site, operation.path, operation.body, signal);
      yield* refreshSurface(active);
      return result(text(payload), "zeroY content updated", `Applied ${input.action}.`, [
        ["Site", input.siteId],
        ["Action", input.action],
      ]);
    }),
  );

export default function piZeroY(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  pi.registerTool({
    name: "zeroy_inspect",
    label: "Inspect zeroY site",
    description: "Read one typed zeroY Connector resource, including external browser checks.",
    parameters: InspectParameters,
    execute: (_id, input, signal) =>
      runTool(withSession(pi, (active) => inspectTool(active, input as InspectInput, signal))),
  });

  pi.registerTool({
    name: "zeroy_theme_apply",
    label: "Update zeroY theme",
    description:
      "Apply one or more hash-preconditioned mutations inside one active WordPress theme.",
    parameters: ThemeApplyParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession(pi, (active) => themeApplyTool(active, input as ThemeApplyInput, signal)),
      ),
  });

  pi.registerTool({
    name: "zeroy_content_apply",
    label: "Update zeroY content",
    description:
      "Update SiteConfig, canonical objects, locale drafts, published pointers, or unpublish a locale.",
    parameters: ContentApplyParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession(pi, (active) => contentApplyTool(active, input as ContentApplyInput, signal)),
      ),
  });

  pi.on("session_start", (_event, context) =>
    run(
      startSession(pi, context).pipe(
        Effect.catch((error) => notifySessionFailure(context, error)),
        Effect.asVoid,
      ),
    ),
  );
  pi.on("session_shutdown", () => {
    const active = sessions.get(pi as object);
    return run(active ? stopSession(pi, active) : Effect.void);
  });
}
