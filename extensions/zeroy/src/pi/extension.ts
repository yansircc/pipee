import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  CONTENT_PROMPT_GUIDELINES,
  ContentStageProviderProjection,
  InspectProviderProjection,
  SiteCommitProviderProjection,
  ThemeStageProviderProjection,
  decodeInspectInput,
  decodeThemeStageInput,
  decodeContentStageInput,
  decodeSiteCommitInput,
} from "../domain/protocol.js";
import { inspectTool, refreshSurface } from "./inspect-tools.js";
import { activeSession, run, startSession, stopSession, withSession } from "./session.js";
import { contentStageTool, siteCommitTool, themeStageTool } from "./stage-tools.js";
import { errorMessage, runTool, type ZeroYToolFailure } from "./tool-result.js";

export { verifyBrowserChallengeWithLocalBrowser } from "../domain/browser-verifier.js";

const registrations = new WeakSet<object>();

const notifySessionFailure = (context: ExtensionContext, error: unknown) =>
  Effect.sync(() => {
    if (context.hasUI) context.ui.notify(`zeroY: ${errorMessage(error)}`, "error");
  });

/**
 * Pi registration is deliberately only composition. Session ownership, reads,
 * deployments, and content mutations live in their respective modules.
 */
export default function piZeroY(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  const inspectProjection = InspectProviderProjection;
  if (inspectProjection._tag === "Failure") {
    const error = inspectProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const contentStageProjection = ContentStageProviderProjection;
  if (contentStageProjection._tag === "Failure") {
    const error = contentStageProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const inspectParameters = inspectProjection.value;
  const contentStageParameters = contentStageProjection.value;
  const themeStageProjection = ThemeStageProviderProjection;
  if (themeStageProjection._tag === "Failure") {
    const error = themeStageProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const siteCommitProjection = SiteCommitProviderProjection;
  if (siteCommitProjection._tag === "Failure") {
    const error = siteCommitProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const themeStageParameters = themeStageProjection.value;
  const siteCommitParameters = siteCommitProjection.value;
  pi.registerTool({
    name: "zeroy_inspect",
    label: "Inspect zeroY site",
    description: "Read one typed zeroY Connector resource, including external browser checks.",
    parameters: inspectParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeInspectInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : inspectTool(active, decoded.value, signal);
        }),
      ),
  });

  pi.registerTool({
    name: "zeroy_theme_stage",
    label: "Stage zeroY theme",
    description:
      "Stage remote WordPress theme file changes into one SiteDraft; changes are not live until commit.",
    parameters: themeStageParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeThemeStageInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : themeStageTool(active, decoded.value, signal);
        }),
      ),
  });
  pi.registerTool({
    name: "zeroy_content_stage",
    label: "Stage zeroY content",
    description: `Stage typed content and translation operations into one remote SiteDraft. ${CONTENT_PROMPT_GUIDELINES}`,
    parameters: contentStageParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeContentStageInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : contentStageTool(active, decoded.value, signal);
        }),
      ),
  });
  pi.registerTool({
    name: "zeroy_site_commit",
    label: "Commit zeroY site",
    description:
      "Compile one remote SiteDraft, run its CandidateProof, and atomically activate one SiteRelease.",
    parameters: siteCommitParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeSiteCommitInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : siteCommitTool(active, decoded.value, signal);
        }),
      ),
  });

  pi.on("session_start", (_event, context) =>
    run(
      startSession(pi, context, refreshSurface).pipe(
        Effect.catch((error) => notifySessionFailure(context, error)),
        Effect.asVoid,
      ),
    ),
  );
  pi.on("session_shutdown", () => {
    const active = activeSession(pi);
    return run(active ? stopSession(pi, active) : Effect.void);
  });
}
