import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  CHECKOUT_PROMPT_GUIDELINES,
  CheckoutProviderProjection,
  InspectProviderProjection,
  PushProviderProjection,
  decodeCheckoutInput,
  decodeInspectInput,
  decodePushInput,
} from "../domain/protocol.js";
import { inspectTool, refreshSurface } from "./inspect-tools.js";
import { activeSession, run, startSession, stopSession, withSession } from "./session.js";
import { checkoutTool, pushTool } from "./checkout-tools.js";
import { errorMessage, runTool, type ZeroYToolFailure } from "./tool-result.js";

export { verifyBrowserChallengeWithLocalBrowser } from "../domain/browser-verifier.js";
export { validateProviderSchemaDocument } from "../domain/protocol.js";

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
  const checkoutProjection = CheckoutProviderProjection;
  if (checkoutProjection._tag === "Failure") {
    const error = checkoutProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const inspectParameters = inspectProjection.value;
  const pushProjection = PushProviderProjection;
  if (pushProjection._tag === "Failure") {
    const error = pushProjection.error;
    pi.on("session_start", (_event, context) => run(notifySessionFailure(context, error)));
    return;
  }
  const checkoutParameters = checkoutProjection.value;
  const pushParameters = pushProjection.value;
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
    name: "zeroy_checkout",
    label: "Checkout zeroY site",
    description: `Materialize one remote SiteCommit as a local SiteCheckout. ${CHECKOUT_PROMPT_GUIDELINES}`,
    parameters: checkoutParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodeCheckoutInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : checkoutTool(active, decoded.value, signal);
        }),
      ),
  });
  pi.registerTool({
    name: "zeroy_push",
    label: "Push zeroY checkout",
    description: `Push one coherent local repair slice. ${CHECKOUT_PROMPT_GUIDELINES}`,
    parameters: pushParameters,
    execute: (_id, input, signal) =>
      runTool(
        withSession<AgentToolResult<unknown>, ZeroYToolFailure>(pi, (active) => {
          const decoded = decodePushInput(input);
          return decoded._tag === "Failure"
            ? Effect.fail(decoded.error)
            : pushTool(active, decoded.value, signal);
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
