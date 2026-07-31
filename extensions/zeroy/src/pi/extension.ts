import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { layer as nodeServicesLayer, type NodeServices } from "@effect/platform-node/NodeServices";
import type { LivePresentationPort } from "@pipee/companion-contracts/host-capabilities";
import {
  livePresentation,
  webSurface,
  withPresentation,
  type WebSurfaceSlot,
} from "@pipee/extension-kit";
import { Clock, Data, Effect, Exit, ManagedRuntime, Scope, Semaphore } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import {
  externalCheckSummary,
  runExternalCheck,
  sameOriginExternalCheckUrls,
  type ExternalCheck,
} from "../domain/checker.js";
import {
  ZeroYConnectionConfigError,
  connectionFor,
  loadSiteConnections,
  type SiteConnection,
} from "../domain/connection.js";
import { ZeroYConnectorError, connectorGet, connectorPost } from "../domain/client.js";
import {
  CONTENT_PROMPT_GUIDELINES,
  ContentProviderProjection,
  InspectProviderProjection,
  ThemeCheckoutInputContract,
  ThemePushInputContract,
  type ProviderSchemaProjectionError,
  type ToolInputValidationError,
  decodeContentInput,
  decodeInspectInput,
  type ContentApplyInput,
  type InspectInput,
  type JsonRecord,
  type ThemeCheckoutInput,
  type ThemePushInput,
} from "../domain/protocol.js";
import {
  createThemeCheckout,
  listThemeCheckouts,
  prepareThemeSeed,
  prepareThemePush,
  type ThemeManifest,
  type ThemePolicy,
} from "../domain/theme-checkout.js";
import { zeroYPresentation } from "./presentation.js";
import { failedSiteView, projectZeroYWebView, type ZeroYSiteView } from "./web-surface.js";

const runtime = ManagedRuntime.make(nodeServicesLayer);
const registrations = new WeakSet<object>();
const bundledThemeSeed = fileURLToPath(new URL("../../mvp-theme/", import.meta.url));

type ActiveSession = {
  readonly context: ExtensionContext;
  readonly scope: Scope.Closeable;
  readonly connections: ReadonlyArray<SiteConnection>;
  readonly presentation: LivePresentationPort | undefined;
  readonly surface: WebSurfaceSlot;
  readonly externalChecks: Map<string, ExternalCheck>;
  readonly mutationGates: ReadonlyMap<string, Semaphore.Semaphore>;
};

class ZeroYSessionUnavailable extends Data.TaggedError("ZeroYSessionUnavailable")<{
  readonly message: string;
}> {}

const sessions = new WeakMap<object, ActiveSession>();
const emptySurface: WebSurfaceSlot = { replace: () => undefined };

const text = (value: unknown): string => JSON.stringify(value, null, 2);
const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const errorPayload = (error: unknown): JsonRecord => {
  if (error instanceof ZeroYConnectorError) {
    return {
      error: {
        code: error.code ?? "zeroy_connector_error",
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.data === undefined ? {} : { data: error.data }),
      },
    };
  }
  return {
    error: {
      code:
        typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag)
          : "zeroy_request_failed",
      message: errorMessage(error),
    },
  };
};
const inspectSiteLabel = (input: InspectInput): string =>
  input.resource === "sites" ? "Configured zeroY sites" : input.siteId;

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

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>): Promise<A> =>
  runtime.runPromise(effect);

const runTool = (
  effect: Effect.Effect<
    AgentToolResult<unknown>,
    | ZeroYConnectorError
    | ZeroYConnectionConfigError
    | ZeroYSessionUnavailable
    | ProviderSchemaProjectionError
    | ToolInputValidationError,
    NodeServices
  >,
): Promise<AgentToolResult<unknown>> =>
  run(
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed(
          result(
            text(errorPayload(error)),
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

const withSession = <A, E, R = NodeServices>(
  pi: ExtensionAPI,
  use: (active: ActiveSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ZeroYSessionUnavailable, R> =>
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
): Effect.Effect<ZeroYSiteView, never, NodeServices> =>
  Effect.all(
    [
      connectorGet(site, "site"),
      connectorGet(site, "schema"),
      connectorGet(site, "inventory?page=1&perPage=100"),
      connectorGet(site, "acf"),
      connectorGet(site, "integrity"),
      connectorGet(site, "theme/state"),
      connectorGet(site, "theme/deployments?limit=20"),
      listThemeCheckouts(site.siteId).pipe(
        Effect.mapError(
          (cause) =>
            new ZeroYConnectorError({
              message: `Could not list local ThemeArtifact checkouts: ${cause.message}`,
            }),
        ),
      ),
    ],
    { concurrency: 7 },
  ).pipe(
    Effect.flatMap(
      ([siteView, schema, inventory, acf, integrity, themeState, deployments, checkouts]) => {
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
          themeState,
          deployments,
          checkouts,
          externalCheck: active.externalChecks.get(site.siteId) ?? null,
        });
      },
    ),
    Effect.catch((error) => Effect.succeed(failedSiteView(site, errorMessage(error)))),
  );

const refreshSurface = (active: ActiveSession): Effect.Effect<void, never, NodeServices> =>
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

const withLivePresentation = <A, E, R>(
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

const withSiteMutationGate = <A, E, R>(
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

const activeThemeState = (
  site: SiteConnection,
  signal: AbortSignal | undefined,
): Effect.Effect<JsonRecord, ZeroYConnectorError, NodeServices> =>
  Effect.gen(function* () {
    const state = yield* connectorGet(site, "theme/state", signal);
    if (state.state === "active") return state;
    if (state.state !== "bootstrap-required") {
      return yield* new ZeroYConnectorError({
        message: "zeroY Stable Shell is active without a recoverable ThemeDeployment.",
        code: "zeroy_theme_recovery_required",
      });
    }
    const policy = asRecord(state.policy);
    if (policy === null) {
      return yield* new ZeroYConnectorError({
        message: "Connector did not provide a ThemeArtifact policy for bootstrap.",
      });
    }
    const seed = yield* prepareThemeSeed({
      sourceDirectory: bundledThemeSeed,
      policy: policy as unknown as ThemePolicy,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZeroYConnectorError({
            message: `Could not prepare the bundled zeroY seed Artifact: ${cause.message}`,
          }),
      ),
    );
    const uploaded = yield* connectorPost(
      site,
      "theme/artifacts",
      { manifest: seed.manifest, archiveBase64: seed.archiveBase64 },
      signal,
    );
    const artifactId = asString(uploaded, "artifactId");
    if (!artifactId) {
      return yield* new ZeroYConnectorError({
        message: "Connector did not return the bootstrap Artifact identity.",
      });
    }
    yield* connectorPost(
      site,
      "theme/bootstrap",
      {
        artifactId,
        provenance: {
          source: "bundled-seed",
          sourceCommit: seed.sourceCommit,
          message: "one-time hard-cut ThemeBootstrap",
        },
      },
      signal,
    );
    const active = yield* connectorGet(site, "theme/state", signal);
    if (active.state !== "active") {
      return yield* new ZeroYConnectorError({
        message: "ThemeBootstrap completed without an active ThemeDeployment.",
      });
    }
    return active;
  }).pipe(Effect.withSpan("zeroy.theme-bootstrap"));

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
): Effect.Effect<void, ZeroYConnectionConfigError, NodeServices> =>
  Effect.gen(function* () {
    const previous = sessions.get(pi as object);
    if (previous) yield* stopSession(pi, previous);
    const scope = yield* Scope.make("sequential");
    yield* Effect.gen(function* () {
      const connections = yield* loadSiteConnections();
      const mutationGates = new Map(
        yield* Effect.forEach(connections, (site) =>
          Semaphore.make(1).pipe(Effect.map((gate) => [site.siteId, gate] as const)),
        ),
      );
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
        mutationGates,
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
  ZeroYConnectorError | ZeroYConnectionConfigError,
  NodeServices
> =>
  Effect.gen(function* () {
    if (input.resource === "sites") {
      return {
        payload: {
          contract: "zeroy/configured-sites@1",
          sites: active.connections.map(({ siteId, label, endpoint }) => ({
            siteId,
            label,
            endpoint,
          })),
        },
        summary: "Listed configured zeroY sites",
      };
    }
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
      case "canonicalContent":
        return {
          payload: yield* connectorGet(
            site,
            `canonical-content?objectId=${input.objectId}`,
            signal,
          ),
          summary: "Read canonical content projection",
        };
      case "adoptionCandidates": {
        const parameters = new URLSearchParams({
          page: String(input.page ?? 1),
          perPage: String(input.perPage ?? 50),
        });
        if (input.postType !== undefined) parameters.set("postType", input.postType);
        if (input.schemaId !== undefined) parameters.set("schemaId", input.schemaId);
        return {
          payload: yield* connectorGet(
            site,
            `adoption-candidates?${parameters.toString()}`,
            signal,
          ),
          summary: "Read unmanaged WordPress adoption candidates",
        };
      }
      case "existingPost":
        return {
          payload: yield* connectorGet(site, `existing-post?postId=${input.postId}`, signal),
          summary: "Read existing WordPress and ACF facts",
        };
      case "themeState":
        return {
          payload: yield* connectorGet(site, "theme/state", signal),
          summary: "Read active ThemeDeployment state",
        };
      case "themeArtifact":
        return {
          payload: yield* connectorGet(site, `theme/artifacts/${input.artifactId}`, signal),
          summary: "Read immutable ThemeArtifact manifest",
        };
      case "translationJob":
        return {
          payload: yield* connectorGet(
            site,
            `translation-job?subject=${encodeURIComponent(JSON.stringify(input.subject))}&locale=${encodeURIComponent(input.locale)}`,
            signal,
          ),
          summary: "Read derived TranslationJob",
        };
      case "integrity":
        return {
          payload: yield* connectorGet(site, "integrity", signal),
          summary: "Ran Connector integrity checks",
        };
      case "externalCheck": {
        const inventory = yield* connectorGet(site, "inventory?page=1&perPage=100", signal);
        const urls = sameOriginExternalCheckUrls(site.endpoint, input.urls ?? []);
        if ("code" in urls) {
          return yield* new ZeroYConnectorError({
            code: urls.code,
            status: 400,
            message: urls.message,
          });
        }
        const check = yield* runExternalCheck(inventory, urls, signal);
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
      ["Site", inspectSiteLabel(input)],
      ["Resource", input.resource],
    ],
    inspectResource(active, input, signal).pipe(
      Effect.map(({ payload, summary }) =>
        result(text(payload), "zeroY inspection", summary, [
          ["Site", inspectSiteLabel(input)],
          ["Resource", input.resource],
        ]),
      ),
    ),
  );

const asString = (record: JsonRecord, key: string): string | undefined =>
  typeof record[key] === "string" ? record[key] : undefined;
const asNumber = (record: JsonRecord | null, key: string): number =>
  typeof record?.[key] === "number" ? record[key] : 0;

const contentResultPresentation = (
  input: ContentApplyInput,
  payload: JsonRecord,
): {
  readonly title: string;
  readonly summary: string;
  readonly fields: ReadonlyArray<readonly [string, string]>;
} => {
  if (
    input.action !== "writeTranslationDraft" &&
    input.action !== "publishTranslation" &&
    input.action !== "unpublishTranslation"
  ) {
    return {
      title: "zeroY content updated",
      summary: `Applied ${input.action}.`,
      fields: [
        ["Site", input.siteId],
        ["Action", input.action],
      ],
    };
  }
  const summary = asRecord(payload.summary);
  const pending =
    asNumber(summary, "missing") + asNumber(summary, "stale") + asNumber(summary, "reviewNeeded");
  const revision = asNumber(payload, "revision");
  const state = asString(payload, "state") ?? input.action;
  const locale = asString(payload, "locale") ?? "translation";
  const previewReady = typeof payload.previewUrl === "string";
  const sentence =
    state === "draft"
      ? `${asNumber(summary, "current")} current · ${pending} need attention${previewReady ? " · preview ready" : ""}`
      : state === "published"
        ? `${asNumber(summary, "current")} current · published`
        : "Public locale route removed; immutable Overlay history is retained.";
  return {
    title: `${locale} translation`,
    summary: sentence,
    fields: [
      ["Site", input.siteId],
      ["State", state],
      ["Revision", String(revision)],
    ],
  };
};

const previewThemeDeployment = (
  previewUrl: string,
  signal: AbortSignal | undefined,
): Effect.Effect<void, ZeroYConnectorError> =>
  Effect.tryPromise({
    try: () => fetch(previewUrl, signal === undefined ? {} : { signal }),
    catch: (cause) =>
      new ZeroYConnectorError({
        message: `Could not load candidate ThemeDeployment preview: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((response) => {
      if (!response.ok) {
        return Effect.fail(
          new ZeroYConnectorError({
            message: `Candidate ThemeDeployment preview returned HTTP ${response.status}.`,
            status: response.status,
          }),
        );
      }
      const robots = response.headers.get("x-robots-tag") ?? "";
      if (!robots.toLowerCase().includes("noindex")) {
        return Effect.fail(
          new ZeroYConnectorError({
            message: "Candidate ThemeDeployment preview did not declare noindex.",
          }),
        );
      }
      return Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new ZeroYConnectorError({
            message: `Could not read candidate ThemeDeployment preview: ${String(cause)}`,
          }),
      });
    }),
    Effect.flatMap((html) =>
      html.trim() === ""
        ? Effect.fail(
            new ZeroYConnectorError({ message: "Candidate ThemeDeployment preview was empty." }),
          )
        : Effect.void,
    ),
    Effect.withSpan("zeroy.theme-deployment.preview"),
  );

const themeCheckoutTool = (
  active: ActiveSession,
  input: ThemeCheckoutInput,
  signal: AbortSignal | undefined,
) =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY theme checkout",
      "Materializing the active immutable ThemeArtifact into a local Git checkout",
      [["Site", input.siteId]],
      Effect.gen(function* () {
        const site = yield* connection(active, input.siteId);
        const state = yield* activeThemeState(site, signal);
        const artifactId = asString(state, "activeArtifactId");
        const deploymentId = asString(state, "activeDeploymentId");
        const policy = asRecord(state.policy);
        if (!artifactId || !deploymentId || policy === null) {
          return yield* new ZeroYConnectorError({
            message: "Connector returned an incomplete ThemeDeployment state.",
          });
        }
        const artifact = yield* connectorGet(site, `theme/artifacts/${artifactId}`, signal);
        const archive = yield* connectorGet(site, `theme/artifacts/${artifactId}/archive`, signal);
        const manifest = artifact.manifest as ThemeManifest | undefined;
        const archiveBase64 = asString(archive, "archiveBase64");
        if (!manifest || !archiveBase64) {
          return yield* new ZeroYConnectorError({
            message: "Connector returned an incomplete ThemeArtifact checkout payload.",
          });
        }
        const checkout = yield* createThemeCheckout({
          siteId: input.siteId,
          artifactId,
          deploymentId,
          manifest,
          archiveBase64,
          policy: policy as unknown as ThemePolicy,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ZeroYConnectorError({
                message: `Could not create local ThemeArtifact checkout: ${cause.message}`,
              }),
          ),
        );
        return result(
          text(checkout),
          "zeroY theme checked out",
          "The active Artifact is now a local Git working copy. Edit, commit, then push the commit.",
          [
            ["Site", input.siteId],
            ["Checkout", checkout.checkoutId],
          ],
        );
      }),
    ),
  );

const themePushTool = (
  active: ActiveSession,
  input: ThemePushInput,
  signal: AbortSignal | undefined,
) =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY theme deployment",
      "Uploading committed Git HEAD as one immutable ThemeArtifact",
      [
        ["Site", input.siteId],
        ["Checkout", input.checkoutId],
      ],
      Effect.gen(function* () {
        const site = yield* connection(active, input.siteId);
        const push = yield* prepareThemePush(input.checkoutId).pipe(
          Effect.mapError(
            (cause) =>
              new ZeroYConnectorError({
                message: `Could not prepare ThemeArtifact push: ${cause.message}`,
              }),
          ),
        );
        if (push.checkout.siteId !== input.siteId) {
          return yield* new ZeroYConnectorError({
            message: "checkoutId belongs to a different zeroY site.",
          });
        }
        const uploaded = yield* connectorPost(
          site,
          "theme/artifacts",
          {
            manifest: push.manifest,
            archiveBase64: push.archiveBase64,
          },
          signal,
        );
        const artifactId = asString(uploaded, "artifactId");
        if (!artifactId)
          return yield* new ZeroYConnectorError({
            message: "Connector did not return an uploaded artifactId.",
          });
        const prepared = yield* connectorPost(
          site,
          "theme/deployments/prepare",
          {
            artifactId,
            expectedActiveArtifactId: push.checkout.baseArtifactId,
            provenance: {
              checkoutId: push.checkout.checkoutId,
              sourceCommit: push.sourceCommit,
              message: input.message ?? "",
            },
          },
          signal,
        );
        if (prepared.state !== "prepared") {
          yield* refreshSurface(active);
          return result(
            text(prepared),
            "zeroY deployment rejected",
            "The active theme was not changed; inspect the deployment diagnostics.",
            [
              ["Site", input.siteId],
              ["Checkout", input.checkoutId],
            ],
            "warning",
          );
        }
        const deploymentId = asString(prepared, "deploymentId");
        const previewUrl = asString(prepared, "previewUrl");
        if (!deploymentId || !previewUrl)
          return yield* new ZeroYConnectorError({
            message: "Connector did not return a prepared ThemeDeployment preview.",
          });
        yield* previewThemeDeployment(previewUrl, signal);
        const activated = yield* connectorPost(
          site,
          `theme/deployments/${deploymentId}/activate`,
          {},
          signal,
        );
        yield* refreshSurface(active);
        return result(
          text(activated),
          "zeroY theme deployed",
          "Activated one complete immutable ThemeArtifact.",
          [
            ["Site", input.siteId],
            ["Artifact", artifactId],
          ],
          "success",
        );
      }),
    ),
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
    case "adoptCanonical":
      return {
        path: "canonical",
        body: {
          action: "adopt",
          postId: input.postId,
          schemaId: input.schemaId,
          expectedSourceHash: input.expectedSourceHash,
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
    case "writeTemplateContent":
      return {
        path: "canonical",
        body: {
          action: "writeTemplateContent",
          objectId: input.objectId,
          templateContent: input.templateContent,
          expectedRevision: input.expectedRevision,
        },
      };
    case "writeTranslationDraft":
      return {
        path: "translation",
        body: {
          action: "writeTranslationDraft",
          jobToken: input.jobToken,
          values: input.values,
          expectedRevision: input.expectedRevision,
        },
      };
    case "publishTranslation":
      return {
        path: "translation",
        body: {
          action: "publishTranslation",
          subject: input.subject,
          locale: input.locale,
          expectedRevision: input.expectedRevision,
        },
      };
    case "unpublishTranslation":
      return {
        path: "translation",
        body: {
          action: "unpublishTranslation",
          subject: input.subject,
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
  withSiteMutationGate(
    active,
    input.siteId,
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
        const presentation = contentResultPresentation(input, payload);
        return result(text(payload), presentation.title, presentation.summary, presentation.fields);
      }),
    ),
  );

export default function piZeroY(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  if (InspectProviderProjection._tag === "Failure") {
    const error = InspectProviderProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const inspectParameters = InspectProviderProjection.value;
  if (ContentProviderProjection._tag === "Failure") {
    const error = ContentProviderProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const contentParameters = ContentProviderProjection.value;

  pi.registerTool({
    name: "zeroy_inspect",
    label: "Inspect zeroY site",
    description: "Read one typed zeroY Connector resource, including external browser checks.",
    parameters: inspectParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<
          AgentToolResult<unknown>,
          | ZeroYConnectorError
          | ZeroYConnectionConfigError
          | ZeroYSessionUnavailable
          | ProviderSchemaProjectionError
          | ToolInputValidationError
        >(pi, (active) => {
          const decoded = decodeInspectInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : inspectTool(active, decoded.value, signal);
        }),
      ),
  });

  pi.registerTool({
    name: "zeroy_theme_checkout",
    label: "Checkout zeroY theme",
    description: "Download the active immutable ThemeArtifact into a local Git checkout.",
    parameters: ThemeCheckoutInputContract,
    execute: (_id, input, signal) =>
      runTool(
        withSession(pi, (active) => themeCheckoutTool(active, input as ThemeCheckoutInput, signal)),
      ),
  });

  pi.registerTool({
    name: "zeroy_theme_push",
    label: "Deploy zeroY theme",
    description:
      "Upload committed checkout Git HEAD as one Artifact, prepare it, and activate only on CAS success.",
    parameters: ThemePushInputContract,
    execute: (_id, input, signal) =>
      runTool(withSession(pi, (active) => themePushTool(active, input as ThemePushInput, signal))),
  });

  pi.registerTool({
    name: "zeroy_content_apply",
    label: "Update zeroY content",
    description: `Update SiteConfig, canonical objects, or immutable LocaleOverlay drafts and published pointers. ${CONTENT_PROMPT_GUIDELINES}`,
    parameters: contentParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<
          AgentToolResult<unknown>,
          | ZeroYConnectorError
          | ZeroYConnectionConfigError
          | ZeroYSessionUnavailable
          | ProviderSchemaProjectionError
          | ToolInputValidationError
        >(pi, (active) => {
          const decoded = decodeContentInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : contentApplyTool(active, decoded.value, signal);
        }),
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
