import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import {
  externalCheckSummary,
  runExternalCheck,
  sameOriginExternalCheckUrls,
} from "../domain/checker.js";
import { ZeroYConnectorError, connectorGet } from "../domain/client.js";
import { type ZeroYConnectionConfigError, type SiteConnection } from "../domain/connection.js";
import type { InspectInput, JsonRecord } from "../domain/protocol.js";
import { listThemeCheckouts } from "../domain/theme-checkout.js";
import { failedSiteView, projectZeroYWebView, type ZeroYSiteView } from "./web-surface.js";
import { connection, type ActiveSession, withLivePresentation } from "./session.js";
import { errorMessage, result, text } from "./tool-result.js";

const inspectSiteLabel = (input: InspectInput): string =>
  input.resource === "sites" ? "Configured zeroY sites" : input.siteId;

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

export const refreshSurface = (active: ActiveSession): Effect.Effect<void, never, NodeServices> =>
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

export const inspectTool = (
  active: ActiveSession,
  input: InspectInput,
  signal: AbortSignal | undefined,
): Effect.Effect<
  AgentToolResult<unknown>,
  ZeroYConnectorError | ZeroYConnectionConfigError,
  NodeServices
> =>
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
