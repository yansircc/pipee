import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { verifyBrowserChallenge } from "../domain/browser-verifier.js";
import { connectorPost, decodeConnectorPayload, ZeroYConnectorError } from "../domain/client.js";
import type {
  ContentStageInput,
  JsonRecord,
  SiteCommitInput,
  ThemeStageInput,
} from "../domain/protocol.js";
import { SiteDraftReceiptContract, SiteReleaseReceiptContract } from "../domain/protocol.js";
import {
  connection,
  type ActiveSession,
  withLivePresentation,
  withSiteMutationGate,
} from "./session.js";
import { result, text, type ZeroYToolFailure } from "./tool-result.js";

const stage = (
  active: ActiveSession,
  siteId: string,
  draftId: string | undefined,
  operation: JsonRecord,
  signal: AbortSignal | undefined,
  title: string,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withSiteMutationGate(
    active,
    siteId,
    withLivePresentation(
      active,
      title,
      "Appending one typed operation to the remote SiteDraft",
      [["Site", siteId]],
      connection(active, siteId).pipe(
        Effect.flatMap((site) =>
          connectorPost(
            site,
            "site-draft-stages",
            { ...(draftId === undefined ? {} : { draftId }), ...operation },
            signal,
            active.draftOwnerId,
          ).pipe(
            Effect.flatMap((receipt) =>
              decodeConnectorPayload(SiteDraftReceiptContract, "SiteDraft receipt", receipt),
            ),
          ),
        ),
        Effect.map((receipt) => {
          const zcssFields: ReadonlyArray<readonly [string, string]> =
            receipt.zcss === null
              ? []
              : [
                  ["ZCSS compiler", receipt.zcss.compiler.id],
                  ["Design", receipt.zcss.designHash.slice(0, 12)],
                  ["Output", receipt.zcss.outputHash.slice(0, 12)],
                ];
          return result(
            text(receipt),
            "zeroY draft staged",
            "The operation is remote and not active until site commit.",
            [["Site", siteId], ["Draft", receipt.draftId], ...zcssFields],
          );
        }),
      ),
    ),
  );

export const themeStageTool = (
  active: ActiveSession,
  input: ThemeStageInput,
  signal: AbortSignal | undefined,
) =>
  stage(
    active,
    input.siteId,
    input.draftId,
    {
      kind: "artifact.files",
      // SiteArtifact selection belongs to the remote compiler. The sole
      // public file-writing capability is the ThemeArtifact.
      artifact: "theme",
      files: input.files,
      message: input.message ?? "",
    },
    signal,
    "zeroY theme stage",
  );

export const contentStageTool = (
  active: ActiveSession,
  input: ContentStageInput,
  signal: AbortSignal | undefined,
) => {
  if (input.operation.kind === "replayDraft" && "sourceDraftId" in input.operation) {
    const { sourceDraftId } = input.operation;
    return withSiteMutationGate(
      active,
      input.siteId,
      withLivePresentation(
        active,
        "zeroY draft replay",
        "Replaying the complete immutable Draft operation log onto the active SiteRelease",
        [
          ["Site", input.siteId],
          ["Source draft", sourceDraftId],
        ],
        Effect.gen(function* () {
          const site = yield* connection(active, input.siteId);
          const receipt = yield* connectorPost(
            site,
            `site-drafts/${sourceDraftId}/replay`,
            {},
            signal,
            active.draftOwnerId,
          );
          const staged = yield* decodeConnectorPayload(
            SiteDraftReceiptContract,
            "SiteDraft replay receipt",
            receipt,
          );
          return result(
            text(staged),
            "zeroY draft replayed",
            "The complete operation log is now staged against the current active SiteRelease.",
            [
              ["Site", input.siteId],
              ["Source draft", sourceDraftId],
              ["New draft", staged.draftId],
            ],
          );
        }),
      ),
    );
  }
  const { kind, ...payload } = input.operation as unknown as JsonRecord;
  return stage(
    active,
    input.siteId,
    input.draftId,
    { kind, ...payload },
    signal,
    "zeroY content stage",
  );
};

export const siteCommitTool = (
  active: ActiveSession,
  input: SiteCommitInput,
  signal: AbortSignal | undefined,
) =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY site commit",
      "Compiling the remote SiteDraft and activating one verified SiteRelease",
      [
        ["Site", input.siteId],
        ["Draft", input.draftId],
      ],
      Effect.gen(function* () {
        const site = yield* connection(active, input.siteId);
        const preparedPayload = yield* connectorPost(
          site,
          `site-drafts/${input.draftId}/commit`,
          { expectedBaseReleaseId: input.expectedBaseReleaseId, message: input.message ?? "" },
          signal,
          active.draftOwnerId,
        );
        const prepared = yield* decodeConnectorPayload(
          SiteReleaseReceiptContract,
          "SiteRelease browser preparation receipt",
          preparedPayload,
        );
        if (prepared.state !== "awaiting-browser" || prepared.browserVerification === null) {
          return yield* new ZeroYConnectorError({
            code: "zeroy_browser_challenge_missing",
            message: "Connector prepared a SiteRelease without its required browser challenge.",
          });
        }
        const browserEvidence = yield* verifyBrowserChallenge(prepared.browserVerification, signal);
        const committed = yield* connectorPost(
          site,
          `site-releases/${prepared.releaseId}/browser-evidence`,
          { browserEvidence },
          signal,
          active.draftOwnerId,
        );
        const release = yield* decodeConnectorPayload(
          SiteReleaseReceiptContract,
          "SiteRelease receipt",
          committed,
        );
        return result(
          text(release),
          "zeroY site committed",
          "One verified SiteRelease is now active.",
          [
            ["Site", input.siteId],
            ["Draft", input.draftId],
            ["Release", release.releaseId],
            ...(release.zcss !== null &&
            typeof release.zcss === "object" &&
            "outputHash" in release.zcss &&
            typeof release.zcss.outputHash === "string"
              ? [["ZCSS output", release.zcss.outputHash.slice(0, 12)] as const]
              : []),
          ],
        );
      }),
    ),
  );
