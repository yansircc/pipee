import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  CONTENT_PROMPT_GUIDELINES,
  ContentProviderProjection,
  InspectProviderProjection,
  SiteCheckoutInputContract,
  SitePushInputContract,
  SiteVerifyInputContract,
  decodeContentInput,
  decodeInspectInput,
  type SiteCheckoutInput,
  type SitePushInput,
  type SiteVerifyInput,
} from "../domain/protocol.js";
import { contentApplyTool } from "./content-tools.js";
import { inspectTool, refreshSurface } from "./inspect-tools.js";
import { activeSession, run, startSession, stopSession, withSession } from "./session.js";
import { siteCheckoutTool, sitePushTool, siteVerifyTool } from "./site-tools.js";
import { errorMessage, runTool, type ZeroYToolFailure } from "./tool-result.js";

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
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeInspectInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : inspectTool(active, decoded.value, signal);
        }),
      ),
  });

  pi.registerTool({
    name: "zeroy_site_checkout",
    label: "Checkout zeroY site",
    description:
      "Download the active atomic SiteRelease into one local Git workspace containing theme and site-logic.",
    parameters: SiteCheckoutInputContract,
    execute: (_id, input, signal) =>
      runTool(
        withSession(pi, (active) => siteCheckoutTool(active, input as SiteCheckoutInput, signal)),
      ),
  });

  pi.registerTool({
    name: "zeroy_site_verify",
    label: "Verify zeroY site workspace",
    description: "Validate that one clean committed Git HEAD produces both SiteRelease artifacts.",
    parameters: SiteVerifyInputContract,
    execute: (_id, input) =>
      runTool(withSession(pi, (active) => siteVerifyTool(active, input as SiteVerifyInput))),
  });

  pi.registerTool({
    name: "zeroy_site_push",
    label: "Release zeroY site",
    description:
      "Build ThemeArtifact and SiteLogicArtifact from one committed Git HEAD, verify their exact composition, and CAS activate the SiteRelease.",
    parameters: SitePushInputContract,
    execute: (_id, input, signal) =>
      runTool(withSession(pi, (active) => sitePushTool(active, input as SitePushInput, signal))),
  });

  pi.registerTool({
    name: "zeroy_content_apply",
    label: "Update zeroY content",
    description: `Update SiteConfig, canonical objects, or immutable LocaleOverlay drafts and published pointers. ${CONTENT_PROMPT_GUIDELINES}`,
    parameters: contentParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeContentInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : contentApplyTool(active, decoded.value, signal);
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
