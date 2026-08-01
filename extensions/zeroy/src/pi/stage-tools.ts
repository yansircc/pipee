import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { connectorPost, decodeConnectorPayload } from "../domain/client.js";
import type {
  ArtifactStageInput,
  ContentStageInput,
  JsonRecord,
  SiteCommitInput,
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
        Effect.map((receipt) =>
          result(
            text(receipt),
            "zeroY draft staged",
            "The operation is remote and not active until site commit.",
            [
              ["Site", siteId],
              ["Draft", receipt.draftId],
            ],
          ),
        ),
      ),
    ),
  );

export const artifactStageTool = (
  active: ActiveSession,
  input: ArtifactStageInput,
  signal: AbortSignal | undefined,
) =>
  stage(
    active,
    input.siteId,
    input.draftId,
    {
      kind: "artifact.files",
      artifact: input.artifact,
      files: input.files,
      message: input.message ?? "",
    },
    signal,
    "zeroY artifact stage",
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
        const committed = yield* connectorPost(
          site,
          `site-drafts/${input.draftId}/commit`,
          { expectedBaseReleaseId: input.expectedBaseReleaseId, message: input.message ?? "" },
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
          ],
        );
      }),
    ),
  );
