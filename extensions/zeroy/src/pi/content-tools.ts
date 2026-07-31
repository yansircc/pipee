import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { connectorPost } from "../domain/client.js";
import type { ContentApplyInput, JsonRecord } from "../domain/protocol.js";
import { refreshSurface } from "./inspect-tools.js";
import {
  connection,
  type ActiveSession,
  withLivePresentation,
  withSiteMutationGate,
} from "./session.js";
import {
  asNumber,
  asRecord,
  asString,
  result,
  text,
  type ZeroYToolFailure,
} from "./tool-result.js";

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

export const contentApplyTool = (
  active: ActiveSession,
  input: ContentApplyInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
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
