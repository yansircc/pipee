import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ZeroYConnectorError, connectorGet, connectorPost } from "../domain/client.js";
import type { SiteConnection } from "../domain/connection.js";
import type { JsonRecord, ThemeCheckoutInput, ThemePushInput } from "../domain/protocol.js";
import {
  createThemeCheckout,
  prepareThemeSeed,
  prepareThemePush,
  type ThemeManifest,
  type ThemePolicy,
} from "../domain/theme-checkout.js";
import { refreshSurface } from "./inspect-tools.js";
import {
  connection,
  type ActiveSession,
  withLivePresentation,
  withSiteMutationGate,
} from "./session.js";
import { asRecord, asString, result, text, type ZeroYToolFailure } from "./tool-result.js";

const bundledThemeSeed = fileURLToPath(new URL("../../mvp-theme/", import.meta.url));

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

export const themeCheckoutTool = (
  active: ActiveSession,
  input: ThemeCheckoutInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
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

export const themePushTool = (
  active: ActiveSession,
  input: ThemePushInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
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
          { manifest: push.manifest, archiveBase64: push.archiveBase64 },
          signal,
        );
        const artifactId = asString(uploaded, "artifactId");
        if (!artifactId) {
          return yield* new ZeroYConnectorError({
            message: "Connector did not return an uploaded artifactId.",
          });
        }
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
        if (!deploymentId || !previewUrl) {
          return yield* new ZeroYConnectorError({
            message: "Connector did not return a prepared ThemeDeployment preview.",
          });
        }
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
        );
      }),
    ),
  );
