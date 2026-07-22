import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import { classifyChromeConnectorCompatibility } from "../protocol/chrome.js";
import { messageOf } from "../core/errors.js";
import { decodePollResponseJson } from "../protocol/codec.js";
import { encodeJsonTransport } from "../protocol/json-transport.js";
import { WireResult as WireResultSchema } from "../protocol/schema.js";
import type {
  PollResponse,
  ProfileConnector,
  WireCommand,
  WireResult,
} from "../protocol/schema.js";
import {
  classifyResultDelivery,
  clearCommandJournal,
  loadCommandJournal,
  recordCommandExecuting,
  recordCommandResult,
} from "./command-journal.js";
import { connectorRuntimeStep, settleBrowserCommand } from "./connector-runtime-step.js";
import {
  ConnectorHttpFailure,
  connectorRequest,
  requireConnectorSuccess,
} from "./connector-http.js";
import {
  type ConnectorIdentityRequest,
  type ConnectorIdentityResponse,
  isConnectorIdentityRequest,
} from "./connector-identity-message.js";
import { ConnectorIdentityOwner } from "./connector-identity.js";
import { RuntimeLoopOwner } from "./runtime-loop-owner.js";
import {
  detachExpiredDebuggers,
  dispatchBrowserCommand,
  handleAutomationTabRemoved,
  handleDebuggerDetach,
  handleDebuggerEvent,
} from "./platform.js";
import { localDurabilityRetrySchedule, sharedBridgeRetrySchedule } from "./runtime-scheduling.js";
import { handleChromeExtensionProbe } from "./external-probe.js";
import {
  BROWSER_COMPANION_WAKE_KIND,
  isBrowserCompanionWakeRequest,
} from "@pipee/companion-contracts/browser-companion";

const KEEPALIVE_ALARM = "pi-chrome-runtime";
const connectorIdentity = ConnectorIdentityOwner.makeUnsafe();
const effectRuntime = ManagedRuntime.make(Layer.empty);

class BrowserRuntimeFailure extends Data.TaggedError("BrowserRuntimeFailure")<{
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
}> {}

const persistUntilSuccess = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ schedule: localDurabilityRetrySchedule }));

const classifyResultResponse = (
  result: WireResult,
  response: { readonly status: number; readonly text: string },
): Effect.Effect<void, ConnectorHttpFailure | BrowserRuntimeFailure> => {
  const decision = classifyResultDelivery(response.status);
  if (decision === "terminal") return Effect.void;
  if (decision === "retry") {
    return Effect.fail(
      new ConnectorHttpFailure({
        code: "bridge-http",
        message: `Bridge returned HTTP ${response.status}: ${response.text}`,
        status: response.status,
      }),
    );
  }
  return Effect.fail(
    new BrowserRuntimeFailure({
      code: "result-rejected",
      message: `Bridge rejected result ${result.id} with HTTP ${response.status}: ${response.text}`,
      status: response.status,
    }),
  );
};

const postResult = (result: WireResult, connector: ProfileConnector) =>
  encodeJsonTransport("Chrome wire result", WireResultSchema, result).pipe(
    Effect.flatMap(({ json }) =>
      connectorRequest(
        "result",
        {
          headers: { "content-type": "application/json" },
          body: json,
        },
        connector,
      ).pipe(
        Effect.flatMap((response) => classifyResultResponse(result, response)),
        Effect.tapError((error) =>
          Effect.logWarning(
            `pi-chrome result ${result.id} is not acknowledged; command polling remains blocked`,
            messageOf(error),
          ),
        ),
        Effect.retry({
          schedule: sharedBridgeRetrySchedule,
          while: (error: ConnectorHttpFailure | BrowserRuntimeFailure) =>
            error.status === undefined || classifyResultDelivery(error.status) === "retry",
        }),
      ),
    ),
  );

const commandFromPollResponse = (
  response: PollResponse,
  connector: ProfileConnector,
): Effect.Effect<WireCommand | undefined, BrowserRuntimeFailure> => {
  const compatibility = classifyChromeConnectorCompatibility(
    {
      extensionId: response.expectedExtensionId,
      displayVersion: response.expectedExtensionDisplayVersion,
      protocolFingerprint: response.expectedProtocolFingerprint,
    },
    connector,
  );
  if (compatibility._tag === "Incompatible") {
    return Effect.fail(
      new BrowserRuntimeFailure({
        code: "extension-protocol-mismatch",
        message:
          `Extension ${connector.extensionDisplayVersion}/${connector.protocolFingerprint.slice(0, 12)} ` +
          `does not match bridge ${response.expectedExtensionDisplayVersion}/${response.expectedProtocolFingerprint.slice(0, 12)}: ` +
          compatibility.mismatches.join(", "),
      }),
    );
  }
  if (response.type === "incompatible") {
    return Effect.fail(
      new BrowserRuntimeFailure({
        code: "extension-protocol-mismatch",
        message:
          `Extension ${response.actualExtensionDisplayVersion}/${response.actualProtocolFingerprint.slice(0, 12)} ` +
          `does not match bridge ${response.expectedExtensionDisplayVersion}/${response.expectedProtocolFingerprint.slice(0, 12)}`,
      }),
    );
  }
  return Effect.succeed(response.type === "none" ? undefined : response.command);
};

const receiveCommand = (connector: ProfileConnector) =>
  connectorRequest("poll", {}, connector).pipe(
    Effect.flatMap(requireConnectorSuccess),
    Effect.flatMap(decodePollResponseJson),
    Effect.flatMap((response) => commandFromPollResponse(response, connector)),
  );

const pollOnce = connectorRuntimeStep({
  loadConnector: connectorIdentity.load,
  loadJournal: persistUntilSuccess(loadCommandJournal),
  deliverResult: postResult,
  clearJournal: persistUntilSuccess(clearCommandJournal),
  receiveCommand,
  recordExecuting: (command) => persistUntilSuccess(recordCommandExecuting(command)),
  executeCommand: (command) => settleBrowserCommand(command, dispatchBrowserCommand),
  recordResult: (command, result) => persistUntilSuccess(recordCommandResult(command, result)),
});

const pollLoop = pollOnce.pipe(
  Effect.tapError((error) => Effect.logWarning("pi-chrome runtime step failed", messageOf(error))),
  Effect.retry({ schedule: sharedBridgeRetrySchedule }),
  Effect.forever,
);

const detachIdle = Clock.currentTimeMillis.pipe(
  Effect.flatMap((now) =>
    Effect.tryPromise({
      try: () => detachExpiredDebuggers(now),
      catch: (cause) =>
        new BrowserRuntimeFailure({
          code: "debugger-cleanup",
          message: messageOf(cause),
          cause,
        }),
    }),
  ),
  Effect.catch((error) => Effect.logWarning("pi-chrome debugger cleanup failed", error.message)),
  Effect.repeat({ schedule: Schedule.spaced("5 seconds") }),
);

const runtime = Effect.all([pollLoop, detachIdle], {
  concurrency: "unbounded",
  discard: true,
});

const runtimeOwner = RuntimeLoopOwner.makeUnsafe(runtime, effectRuntime.runFork);

const startRuntime = (): void => {
  effectRuntime.runCallback(runtimeOwner.start, { onExit: () => undefined });
};

const armKeepalive = () =>
  Effect.tryPromise({
    try: () => chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }),
    catch: (cause) =>
      new BrowserRuntimeFailure({
        code: "alarm",
        message: messageOf(cause),
        cause,
      }),
  });

const initialize = Effect.all(
  [
    connectorIdentity.load,
    armKeepalive(),
    Effect.tryPromise({
      try: () => chrome.action.setBadgeText({ text: "pi" }),
      catch: (cause) =>
        new BrowserRuntimeFailure({
          code: "badge",
          message: messageOf(cause),
          cause,
        }),
    }),
    Effect.tryPromise({
      try: () => chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" }),
      catch: (cause) =>
        new BrowserRuntimeFailure({
          code: "badge",
          message: messageOf(cause),
          cause,
        }),
    }),
  ],
  { discard: true },
).pipe(
  Effect.catch((error) => Effect.logWarning("pi-chrome initialization failed", error.message)),
);

const launch = (effect: Effect.Effect<unknown>): void => {
  effectRuntime.runCallback(effect, { onExit: () => undefined });
};

const handleConnectorIdentityRequest = (
  request: ConnectorIdentityRequest,
): Effect.Effect<ConnectorIdentityResponse> =>
  (request.type === "pi-chrome/connector/load"
    ? connectorIdentity.load
    : connectorIdentity.rename(request.label)
  ).pipe(
    Effect.match({
      onFailure: (error): ConnectorIdentityResponse => ({
        ok: false,
        error: error.message,
      }),
      onSuccess: (connector): ConnectorIdentityResponse => ({ ok: true, connector }),
    }),
  );

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isConnectorIdentityRequest(message)) return false;
  launch(
    handleConnectorIdentityRequest(message).pipe(
      Effect.tap((response) => Effect.sync(() => sendResponse(response))),
    ),
  );
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (isBrowserCompanionWakeRequest(message)) {
    launch(
      runtimeOwner.restart.pipe(
        Effect.andThen(
          Effect.sync(() =>
            sendResponse({
              kind: BROWSER_COMPANION_WAKE_KIND,
              version: 2,
              accepted: true,
            }),
          ),
        ),
      ),
    );
    return true;
  }
  const response = handleChromeExtensionProbe(
    message,
    chrome.runtime,
    __PI_CHROME_PROTOCOL_FINGERPRINT__,
  );
  if (response === undefined) return false;
  sendResponse(response);
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  launch(initialize);
  startRuntime();
});

chrome.runtime.onStartup.addListener(() => {
  launch(
    armKeepalive().pipe(
      Effect.catch((error) => Effect.logWarning("pi-chrome keepalive alarm failed", error.message)),
    ),
  );
  startRuntime();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) startRuntime();
});

chrome.debugger.onDetach.addListener((source, reason) => {
  launch(Effect.sync(() => handleDebuggerDetach(source, reason)));
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  launch(Effect.sync(() => handleDebuggerEvent(source, method, params)));
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  launch(
    Effect.tryPromise({
      try: () => handleAutomationTabRemoved(tabId, removeInfo),
      catch: (cause) =>
        new BrowserRuntimeFailure({
          code: "owned-tab-removal",
          message: messageOf(cause),
          cause,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("pi-chrome owned-tab removal reconciliation failed", error.message),
      ),
    ),
  );
});

launch(initialize);
startRuntime();
