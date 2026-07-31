import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { ZeroYConnectorError, connectorGet, connectorPost } from "../domain/client.js";
import type { SiteConnection } from "../domain/connection.js";
import type {
  JsonRecord,
  SiteCheckoutInput,
  SitePushInput,
  SiteVerifyInput,
} from "../domain/protocol.js";
import {
  createSiteWorkspace,
  prepareSitePush,
  prepareSiteSeed,
  type ArtifactManifest,
  type ArtifactPolicy,
} from "../domain/site-workspace.js";
import { refreshSurface } from "./inspect-tools.js";
import {
  connection,
  type ActiveSession,
  withLivePresentation,
  withSiteMutationGate,
} from "./session.js";
import { asRecord, asString, result, text, type ZeroYToolFailure } from "./tool-result.js";

const bundledThemeSeed = fileURLToPath(new URL("../../mvp-theme/", import.meta.url));
const bundledLogicSeed = fileURLToPath(
  new URL("../../wordpress-plugin/bootstrap-site-logic/", import.meta.url),
);

type ReleaseState = JsonRecord & {
  readonly state?: unknown;
  readonly activeReleaseId?: unknown;
  readonly themeArtifactId?: unknown;
  readonly siteLogicArtifactId?: unknown;
  readonly themePolicy?: unknown;
  readonly siteLogicPolicy?: unknown;
};

const policies = (
  state: ReleaseState,
): Effect.Effect<
  { readonly themePolicy: ArtifactPolicy; readonly siteLogicPolicy: ArtifactPolicy },
  ZeroYConnectorError
> => {
  const themePolicy = asRecord(state.themePolicy);
  const siteLogicPolicy = asRecord(state.siteLogicPolicy);
  return themePolicy === null || siteLogicPolicy === null
    ? Effect.fail(
        new ZeroYConnectorError({
          message: "Connector did not return SiteRelease artifact policies.",
        }),
      )
    : Effect.succeed({
        themePolicy: themePolicy as unknown as ArtifactPolicy,
        siteLogicPolicy: siteLogicPolicy as unknown as ArtifactPolicy,
      });
};

const bootstrap = (
  site: SiteConnection,
  state: ReleaseState,
  signal: AbortSignal | undefined,
): Effect.Effect<ReleaseState, ZeroYConnectorError, NodeServices> =>
  Effect.gen(function* () {
    const policy = yield* policies(state);
    const seed = yield* prepareSiteSeed({
      themeSourceDirectory: bundledThemeSeed,
      siteLogicSourceDirectory: bundledLogicSeed,
      ...policy,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ZeroYConnectorError({
            message: `Could not prepare the bundled SiteRelease seed: ${cause.message}`,
          }),
      ),
    );
    const theme = yield* connectorPost(
      site,
      "site-release/theme-artifacts",
      { manifest: seed.theme.manifest, archiveBase64: seed.theme.archiveBase64 },
      signal,
    );
    const siteLogic = yield* connectorPost(
      site,
      "site-release/site-logic-artifacts",
      { manifest: seed.siteLogic.manifest, archiveBase64: seed.siteLogic.archiveBase64 },
      signal,
    );
    const themeArtifactId = asString(theme, "artifactId");
    const siteLogicArtifactId = asString(siteLogic, "artifactId");
    if (!themeArtifactId || !siteLogicArtifactId) {
      return yield* new ZeroYConnectorError({
        message: "Connector did not return bootstrap Artifact identities.",
      });
    }
    const prepared = yield* connectorPost(
      site,
      "site-releases/prepare",
      {
        themeArtifactId,
        siteLogicArtifactId,
        expectedActiveReleaseId: null,
        provenance: {
          source: "bundled-seed",
          sourceCommit: seed.sourceCommit,
          message: "one-time SiteRelease bootstrap",
        },
      },
      signal,
    );
    const releaseId = asString(prepared, "releaseId");
    if (prepared.state !== "prepared" || !releaseId) {
      return yield* new ZeroYConnectorError({
        message: "Bundled SiteRelease did not pass authoritative verification.",
      });
    }
    yield* connectorPost(site, `site-releases/${releaseId}/activate`, {}, signal);
    return (yield* connectorGet(site, "site-release/state", signal)) as ReleaseState;
  });

const activeState = (
  site: SiteConnection,
  signal: AbortSignal | undefined,
): Effect.Effect<ReleaseState, ZeroYConnectorError, NodeServices> =>
  Effect.gen(function* () {
    const state = (yield* connectorGet(site, "site-release/state", signal)) as ReleaseState;
    if (state.state === "active") return state;
    if (state.state !== "bootstrap-required") {
      return yield* new ZeroYConnectorError({
        message: "zeroY has no recoverable active SiteRelease.",
      });
    }
    return yield* bootstrap(site, state, signal);
  });

const artifactCheckout = (
  site: SiteConnection,
  kind: "theme" | "site-logic",
  artifactId: string,
  signal: AbortSignal | undefined,
): Effect.Effect<
  { readonly manifest: ArtifactManifest; readonly archiveBase64: string },
  ZeroYConnectorError
> =>
  Effect.gen(function* () {
    const artifact = yield* connectorGet(
      site,
      `site-release/${kind}-artifacts/${artifactId}`,
      signal,
    );
    const archive = yield* connectorGet(
      site,
      `site-release/${kind}-artifacts/${artifactId}/archive`,
      signal,
    );
    const manifest = artifact.manifest as ArtifactManifest | undefined;
    const archiveBase64 = asString(archive, "archiveBase64");
    if (!manifest || !archiveBase64)
      return yield* new ZeroYConnectorError({
        message: `Connector returned an incomplete ${kind} Artifact checkout payload.`,
      });
    return { manifest, archiveBase64 };
  });

export const siteCheckoutTool = (
  active: ActiveSession,
  input: SiteCheckoutInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY site checkout",
      "Materializing the active atomic SiteRelease into one Git workspace",
      [["Site", input.siteId]],
      Effect.gen(function* () {
        const site = yield* connection(active, input.siteId);
        const state = yield* activeState(site, signal);
        const releaseId = asString(state, "activeReleaseId");
        const themeArtifactId = asString(state, "themeArtifactId");
        const siteLogicArtifactId = asString(state, "siteLogicArtifactId");
        if (!releaseId || !themeArtifactId || !siteLogicArtifactId)
          return yield* new ZeroYConnectorError({
            message: "Connector returned an incomplete active SiteRelease.",
          });
        const policy = yield* policies(state);
        const [theme, siteLogic] = yield* Effect.all(
          [
            artifactCheckout(site, "theme", themeArtifactId, signal),
            artifactCheckout(site, "site-logic", siteLogicArtifactId, signal),
          ],
          { concurrency: 2 },
        );
        const workspace = yield* createSiteWorkspace({
          siteId: input.siteId,
          releaseId,
          themeArtifactId,
          siteLogicArtifactId,
          theme: { ...theme, policy: policy.themePolicy },
          siteLogic: { ...siteLogic, policy: policy.siteLogicPolicy },
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ZeroYConnectorError({
                message: `Could not create SiteWorkspace: ${cause.message}`,
              }),
          ),
        );
        return result(
          text(workspace),
          "zeroY site checked out",
          "Theme and SiteLogic now share one local Git HEAD.",
          [
            ["Site", input.siteId],
            ["Checkout", workspace.checkoutId],
          ],
        );
      }),
    ),
  );

export const siteVerifyTool = (
  active: ActiveSession,
  input: SiteVerifyInput,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withLivePresentation(
    active,
    "zeroY local verification",
    "Checking that SiteWorkspace has one clean, committed source tree",
    [["Checkout", input.checkoutId]],
    prepareSitePush(input.checkoutId).pipe(
      Effect.flatMap((prepared) =>
        prepared.checkout.siteId === input.siteId
          ? Effect.succeed(
              result(
                text({
                  sourceCommit: prepared.sourceCommit,
                  themeFiles: prepared.theme.manifest.entries.length,
                  siteLogicFiles: prepared.siteLogic.manifest.entries.length,
                }),
                "zeroY local verification passed",
                "Committed Git HEAD produced both immutable Artifact manifests.",
                [
                  ["Site", input.siteId],
                  ["Checkout", input.checkoutId],
                ],
              ),
            )
          : Effect.fail(
              new ZeroYConnectorError({ message: "checkoutId belongs to a different zeroY site." }),
            ),
      ),
      Effect.mapError((cause) =>
        cause instanceof ZeroYConnectorError
          ? cause
          : new ZeroYConnectorError({
              message: `Local SiteWorkspace verification failed: ${cause.message}`,
            }),
      ),
    ),
  );

export const sitePushTool = (
  active: ActiveSession,
  input: SitePushInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY site release",
      "Verifying and activating one ThemeArtifact × SiteLogicArtifact release",
      [
        ["Site", input.siteId],
        ["Checkout", input.checkoutId],
      ],
      Effect.gen(function* () {
        const site = yield* connection(active, input.siteId);
        const prepared = yield* prepareSitePush(input.checkoutId).pipe(
          Effect.mapError(
            (cause) =>
              new ZeroYConnectorError({
                message: `Could not prepare SiteRelease push: ${cause.message}`,
              }),
          ),
        );
        if (prepared.checkout.siteId !== input.siteId)
          return yield* new ZeroYConnectorError({
            message: "checkoutId belongs to a different zeroY site.",
          });
        const [theme, siteLogic] = yield* Effect.all(
          [
            connectorPost(
              site,
              "site-release/theme-artifacts",
              { manifest: prepared.theme.manifest, archiveBase64: prepared.theme.archiveBase64 },
              signal,
            ),
            connectorPost(
              site,
              "site-release/site-logic-artifacts",
              {
                manifest: prepared.siteLogic.manifest,
                archiveBase64: prepared.siteLogic.archiveBase64,
              },
              signal,
            ),
          ],
          { concurrency: 2 },
        );
        const themeArtifactId = asString(theme, "artifactId");
        const siteLogicArtifactId = asString(siteLogic, "artifactId");
        if (!themeArtifactId || !siteLogicArtifactId)
          return yield* new ZeroYConnectorError({
            message: "Connector did not return both Artifact identities.",
          });
        const release = yield* connectorPost(
          site,
          "site-releases/prepare",
          {
            themeArtifactId,
            siteLogicArtifactId,
            expectedActiveReleaseId: prepared.checkout.baseReleaseId,
            provenance: {
              checkoutId: prepared.checkout.checkoutId,
              sourceCommit: prepared.sourceCommit,
              message: input.message ?? "",
            },
          },
          signal,
        );
        if (release.state !== "prepared") {
          yield* refreshSurface(active);
          return result(
            text(release),
            "zeroY release rejected",
            "The active SiteRelease did not change; repair the authoritative VerificationProof failures.",
            [
              ["Site", input.siteId],
              ["Checkout", input.checkoutId],
            ],
            "warning",
          );
        }
        const releaseId = asString(release, "releaseId");
        if (!releaseId)
          return yield* new ZeroYConnectorError({
            message: "Connector did not return a prepared SiteRelease identity.",
          });
        const activated = yield* connectorPost(
          site,
          `site-releases/${releaseId}/activate`,
          {},
          signal,
        );
        yield* refreshSurface(active);
        return result(
          text(activated),
          "zeroY site released",
          "Activated one verified atomic SiteRelease.",
          [
            ["Site", input.siteId],
            ["Release", releaseId],
          ],
        );
      }),
    ),
  );
