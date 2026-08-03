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
import { type InspectInput, type JsonRecord } from "../domain/protocol.js";
import { failedSiteView, projectZeroYWebView, type ZeroYSiteView } from "./web-surface.js";
import { connection, type ActiveSession, withLivePresentation } from "./session.js";
import { errorMessage, result, text } from "./tool-result.js";

const activeReleaseExternalTargets = (payload: JsonRecord) => {
  const targets = Array.isArray(payload.targets) ? payload.targets : null;
  if (payload.contract !== "zeroy/site-release-external-targets@1" || targets === null) return null;
  const decoded = targets.map((target) => {
    const value = target as JsonRecord;
    return typeof value.scenarioId === "string" &&
      typeof value.routeKind === "string" &&
      (typeof value.objectId === "number" || value.objectId === null) &&
      (typeof value.locale === "string" || value.locale === null) &&
      typeof value.url === "string" &&
      typeof value.expectedStatus === "number"
      ? {
          scenarioId: value.scenarioId,
          routeKind: value.routeKind,
          objectId: value.objectId,
          locale: value.locale,
          url: value.url,
          expectedStatus: value.expectedStatus,
        }
      : null;
  });
  return decoded.every((target) => target !== null) ? decoded : null;
};

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
      connectorGet(site, "site-release/state"),
      connectorGet(site, "site-releases?limit=20"),
    ],
    { concurrency: 6 },
  ).pipe(
    Effect.flatMap(([siteView, schema, inventory, acf, integrity, siteRelease, releases]) => {
      if (siteView.siteId !== site.siteId) {
        return Effect.fail(
          new ZeroYConnectorError({
            message: `Connection ${site.label} expected siteId ${site.siteId}, but the Connector reported ${String(siteView.siteId)}.`,
          }),
        );
      }
      const releaseId =
        typeof siteRelease.activeReleaseId === "string" ? siteRelease.activeReleaseId : null;
      return Effect.all(
        [
          releaseId === null
            ? Effect.succeed(null)
            : connectorGet(site, `site-releases/${releaseId}`),
          releaseId === null || typeof siteRelease.siteLogicArtifactId !== "string"
            ? Effect.succeed(null)
            : connectorGet(
                site,
                `site-release/site-logic-artifacts/${siteRelease.siteLogicArtifactId}`,
              ),
          connectorGet(site, "site-release/migrations?limit=50"),
        ],
        { concurrency: 3 },
      ).pipe(
        Effect.map(([activeRelease, activeSiteLogic, migrationHistory]) => ({
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
          siteRelease,
          activeRelease,
          activeSiteLogic,
          migrationHistory,
          releases,
          externalCheck: active.externalChecks.get(site.siteId) ?? null,
        })),
      );
    }),
    Effect.catch((error) => Effect.succeed(failedSiteView(site, errorMessage(error)))),
  );

export const refreshSurface = (active: ActiveSession): Effect.Effect<void, never, NodeServices> =>
  active.surface === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const surface = active.surface;
        if (surface === undefined) return;
        const sites = yield* Effect.forEach(
          active.connections,
          (site) => inspectConnection(active, site),
          {
            concurrency: 4,
          },
        );
        const observedAt = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => surface.replace(projectZeroYWebView(sites, String(observedAt))));
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
      case "refs": {
        const parameters = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.cursor !== undefined) parameters.set("cursor", input.cursor);
        return {
          payload: yield* connectorGet(site, `site-refs?${parameters.toString()}`, signal),
          summary: "Read DraftRefs",
        };
      }
      case "commit": {
        const view = input.commitView ?? "summary";
        if (view === "summary") {
          return {
            payload: yield* connectorGet(site, `site-commits/${input.commit ?? ""}`, signal),
            summary: "Read immutable SiteCommit",
          };
        }
        const parameters = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.cursor !== undefined) parameters.set("cursor", input.cursor);
        if (input.commit !== undefined) parameters.set("commit", input.commit);
        if (view === "diff" && input.base !== undefined) parameters.set("base", input.base);
        return {
          payload: yield* connectorGet(
            site,
            `${view === "diff" ? "site-commit-diff" : "site-commits"}?${parameters.toString()}`,
            signal,
          ),
          summary: view === "diff" ? "Read bounded SiteCommit diff" : "Read SiteCommit history",
        };
      }
      case "releaseHistory": {
        const parameters = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.cursor !== undefined) parameters.set("cursor", input.cursor);
        return {
          payload: yield* connectorGet(site, `site-releases?${parameters.toString()}`, signal),
          summary: "Read SiteRelease history",
        };
      }
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
        if (input.inventoryView === "existingPost") {
          const parameters = new URLSearchParams();
          if (input.schemaId !== undefined) parameters.set("schemaId", input.schemaId);
          return {
            payload: yield* connectorGet(
              site,
              `existing-post?postId=${input.objectId ?? 0}&${parameters.toString()}`,
              signal,
            ),
            summary: "Read one unmanaged WordPress post with sourceHash",
          };
        }
        if (input.inventoryView === "adoptionCandidates") {
          const parameters = new URLSearchParams({ page: String(page), perPage: String(perPage) });
          if (input.schemaId !== undefined) parameters.set("schemaId", input.schemaId);
          if (input.postType !== undefined) parameters.set("postType", input.postType);
          return {
            payload: yield* connectorGet(
              site,
              `adoption-candidates?${parameters.toString()}`,
              signal,
            ),
            summary: "Read unmanaged WordPress adoption candidates",
          };
        }
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
      case "zcssContract":
        return {
          payload: yield* connectorGet(site, "zcss-contract", signal),
          summary: "Read ZCSS authoring contract",
        };
      case "proof": {
        const parameters = new URLSearchParams({
          view: input.proofView ?? "summary",
          limit: String(input.proofLimit ?? 20),
        });
        if (input.proofCursor !== undefined) parameters.set("cursor", input.proofCursor);
        return {
          payload: yield* connectorGet(
            site,
            `site-release-proofs/${input.proofId}?${parameters.toString()}`,
            signal,
            active.draftActorId,
          ),
          summary: "Read CandidateProof diagnostics",
        };
      }
      case "integrity":
        return {
          payload: yield* connectorGet(site, "integrity", signal),
          summary: "Ran Connector integrity checks",
        };
      case "externalCheck": {
        const releaseTargetsPayload = yield* connectorGet(
          site,
          "site-release/external-check-targets",
          signal,
        );
        const releaseTargets = activeReleaseExternalTargets(releaseTargetsPayload);
        if (releaseTargets === null) {
          return yield* new ZeroYConnectorError({
            code: "zeroy_external_check_targets_invalid",
            status: 409,
            message: "Connector did not return active SiteRelease external-check targets.",
          });
        }
        const urls = sameOriginExternalCheckUrls(site.endpoint, input.urls ?? []);
        if ("code" in urls) {
          return yield* new ZeroYConnectorError({
            code: urls.code,
            status: 400,
            message: urls.message,
          });
        }
        const check = yield* runExternalCheck(releaseTargets, urls, signal);
        yield* Effect.sync(() => active.externalChecks.set(site.siteId, check));
        yield* refreshSurface(active);
        return {
          payload: { releaseTargets: releaseTargetsPayload, externalCheck: check },
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
