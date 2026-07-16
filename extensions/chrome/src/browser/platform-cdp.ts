import type {
  CdpCommandParams,
  CdpCommandResult,
  CdpExceptionDetails,
  CdpMethod,
  CdpPageLifecycleEvent,
  CdpRuntimeEvaluateResult,
  ScriptExecutionResult,
} from "./platform-cdp-types.js";
import { COMMAND_DEADLINES_MS } from "../protocol/bridge-contract.js";
import { withResourceLease } from "./platform-resource-lease.js";

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
type AttachedTab = {
  detachAt: number;
  activeCommands: number;
  pointer: { x: number; y: number };
  debuggee: chrome.debugger.Debuggee;
  navigationInitScript?: NavigationInitScriptLease;
  navigation?: NavigationTransition;
};

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (cause: unknown) => void;
};

type NavigationMilestone = "commit" | "load";

type NavigationTarget = {
  readonly frameId: string;
  readonly loaderId: string;
  readonly milestone: NavigationMilestone;
};

type NavigationTransition = {
  readonly generation: string;
  readonly completion: Deferred<void>;
  readonly earlyEventKeys: Set<string>;
  target?: NavigationTarget;
  settled: boolean;
};

type NavigationInitScriptLease =
  | { readonly state: "registering" }
  | { readonly state: "registered"; readonly identifier: string };

export type NavigationCompletion =
  | {
      readonly kind: "same-document";
      readonly frameId: string;
      readonly initScriptExecuted: false;
    }
  | {
      readonly kind: "new-document";
      readonly frameId: string;
      readonly loaderId: string;
      readonly milestone: NavigationMilestone;
    };

export type NavigateTabRequest = {
  readonly tabId: number;
  readonly url: string;
  readonly milestone: NavigationMilestone;
  readonly timeoutMs: number;
  readonly initScriptSource: string;
};

type AttachingDebugger = {
  readonly tag: "attaching";
  readonly completion: Promise<AttachedTab>;
  detachedByEvent: boolean;
};

type AttachedDebugger = {
  readonly tag: "attached";
  readonly session: AttachedTab;
};

type DetachingDebugger = {
  readonly tag: "detaching";
  readonly session: AttachedTab;
  readonly completion: Promise<void>;
  detachedByEvent: boolean;
};

type DebuggerState = AttachingDebugger | AttachedDebugger | DetachingDebugger;

const debuggerStates = new Map<number, DebuggerState>();
const navigationTurns = new Map<number, Promise<void>>();
const INPUT_IDLE_DETACH_MS = 15_000;
const MAX_BUFFERED_NAVIGATION_EVENTS = 256;
const CDP_VERSION = "1.3";

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const attachedSession = (tabId: number): AttachedTab | undefined => {
  const state = debuggerStates.get(tabId);
  return state?.tag === "attached" ? state.session : undefined;
};

const attachedTabIds = (): Array<number> =>
  [...debuggerStates].flatMap(([tabId, state]) => (state.tag === "attached" ? [tabId] : []));

const matchesNavigationTarget = (event: CdpPageLifecycleEvent, target: NavigationTarget): boolean =>
  event.frameId === target.frameId &&
  event.loaderId === target.loaderId &&
  event.name === navigationEventNameFor(target.milestone);

const navigationEventNameFor = (milestone: NavigationMilestone): "init" | "load" =>
  milestone === "commit" ? "init" : "load";

const navigationEventKey = (frameId: string, loaderId: string, milestone: string): string =>
  JSON.stringify([frameId, loaderId, milestone]);

const settleNavigation = (transition: NavigationTransition, cause?: unknown): void => {
  if (transition.settled) return;
  transition.settled = true;
  if (cause === undefined) transition.completion.resolve(undefined);
  else transition.completion.reject(cause);
};

const applyNavigationEvent = (
  transition: NavigationTransition,
  event: CdpPageLifecycleEvent,
): void => {
  const target = transition.target;
  if (!target) {
    const key = navigationEventKey(event.frameId, event.loaderId, event.name);
    if (
      !transition.earlyEventKeys.has(key) &&
      transition.earlyEventKeys.size >= MAX_BUFFERED_NAVIGATION_EVENTS
    ) {
      settleNavigation(
        transition,
        new Error(
          `Navigation generation ${transition.generation} exceeded ${MAX_BUFFERED_NAVIGATION_EVENTS} buffered lifecycle events`,
        ),
      );
      return;
    }
    transition.earlyEventKeys.add(key);
    return;
  }
  if (matchesNavigationTarget(event, target)) settleNavigation(transition);
};

const bindNavigationTarget = (transition: NavigationTransition, target: NavigationTarget): void => {
  transition.target = target;
  if (
    transition.earlyEventKeys.has(
      navigationEventKey(target.frameId, target.loaderId, navigationEventNameFor(target.milestone)),
    )
  ) {
    settleNavigation(transition);
  }
  transition.earlyEventKeys.clear();
};

const waitForNavigation = (
  transition: NavigationTransition,
  timeoutMs: number,
  tabId: number,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settleNavigation(
        transition,
        new Error(
          `Timed out after ${timeoutMs}ms waiting for ${transition.target?.milestone ?? "navigation"} on tab ${tabId}`,
        ),
      );
    }, timeoutMs);
    void transition.completion.promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });

const withNavigationDeadline = <Value>(
  tabId: number,
  transition: NavigationTransition,
  timeoutMs: number,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const deadlineMs = timeoutMs + COMMAND_DEADLINES_MS.navigateOverhead;
  return new Promise<Value>((resolve, reject) => {
    let completed = false;
    const finish = (complete: () => void): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      complete();
    };
    const timer = setTimeout(() => {
      const timeout = new Error(
        `Navigation transaction timed out after ${deadlineMs}ms on tab ${tabId}`,
      );
      settleNavigation(transition, timeout);
      void detachDebugger(tabId).then(
        () => finish(() => reject(timeout)),
        (resetCause: unknown) =>
          finish(() =>
            reject(
              new AggregateError(
                [timeout, resetCause],
                `Navigation transaction timed out and debugger reset failed for tab ${tabId}`,
              ),
            ),
          ),
      );
    }, deadlineMs);
    void execute().then(
      (value) => finish(() => resolve(value)),
      (cause: unknown) => finish(() => reject(cause)),
    );
  });
};

const withNavigationTurn = async <Value>(
  tabId: number,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const previous = navigationTurns.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  navigationTurns.set(tabId, current);
  await previous;
  try {
    return await execute();
  } finally {
    release();
    if (navigationTurns.get(tabId) === current) navigationTurns.delete(tabId);
  }
};

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
export function rng(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function inputStatus() {
  return {
    attachedTabs: attachedTabIds(),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
  };
}

function errorText(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error);
}

function isDebuggerSessionLost(error: unknown): boolean {
  return /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(
    errorText(error),
  );
}

function isUnknownInitScript(error: unknown): boolean {
  return /No script with given id|No script.*identifier|Unknown script identifier|Script with identifier .* (?:does not exist|not found)/i.test(
    errorText(error),
  );
}

async function debuggerAttachRaw(tabId: number): Promise<chrome.debugger.Debuggee> {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, CDP_VERSION);
  return debuggee;
}

const completeDebuggerAttach = async (
  tabId: number,
  transition: AttachingDebugger,
): Promise<AttachedTab> => {
  let debuggee: chrome.debugger.Debuggee;
  try {
    debuggee = await debuggerAttachRaw(tabId);
  } catch (error) {
    if (debuggerStates.get(tabId) === transition) debuggerStates.delete(tabId);
    const message = errorText(error);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    if (
      !tabSnapshot ||
      (tabSnapshot.url || "").startsWith("chrome://") ||
      (tabSnapshot.url || "").startsWith("chrome-extension://")
    ) {
      throw new Error(
        `Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`,
      );
    }
    if (/Another debugger|already attached/i.test(message)) {
      throw new Error(
        `Another debugger is attached to tab ${tabId}; pi-chrome will not detach or replace it.`,
        { cause: error },
      );
    }
    const meta = await describeInputTarget(tabId);
    throw new Error(
      `Chrome debugger attach failed for tab ${tabId}: ${message}${targetMetaSuffix(meta)}`,
      { cause: error },
    );
  }

  // Seed pointer in a plausible "just left the address bar" location.
  const entry = {
    detachAt: Date.now() + INPUT_IDLE_DETACH_MS,
    activeCommands: 0,
    pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 },
    debuggee,
  };
  if (debuggerStates.get(tabId) !== transition || transition.detachedByEvent) {
    if (debuggerStates.get(tabId) === transition) debuggerStates.delete(tabId);
    throw new Error(`Chrome debugger detached while attaching to tab ${tabId}`);
  }
  debuggerStates.set(tabId, { tag: "attached", session: entry });
  return entry;
};

const beginDebuggerAttach = (tabId: number): Promise<AttachedTab> => {
  const completion = deferred<AttachedTab>();
  const transition: AttachingDebugger = {
    tag: "attaching",
    completion: completion.promise,
    detachedByEvent: false,
  };
  debuggerStates.set(tabId, transition);
  void completeDebuggerAttach(tabId, transition).then(completion.resolve, completion.reject);
  return completion.promise;
};

export async function attachDebugger(tabId: number): Promise<AttachedTab> {
  if (!chrome.debugger)
    throw new Error(
      "chrome.debugger API unavailable; reload the extension to grant the new permission",
    );

  while (true) {
    const state = debuggerStates.get(tabId);
    if (!state) return beginDebuggerAttach(tabId);
    if (state.tag === "attached") {
      // A one-shot init-script lease outside its navigation generation is tainted: Chrome may
      // still execute that script on a future document. Reset the Page-domain session before any
      // later command can reuse the debugger.
      if (state.session.navigationInitScript && !state.session.navigation) {
        await beginDebuggerDetach(tabId, state.session);
        continue;
      }
      state.session.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
      return state.session;
    }
    if (state.tag === "attaching") return state.completion;
    try {
      await state.completion;
    } catch {}
  }
}

async function describeInputTarget(tabId: number) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active =
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets: Array<chrome.debugger.TargetInfo> = [];
  try {
    targets = await new Promise<Array<chrome.debugger.TargetInfo>>((resolve) =>
      chrome.debugger.getTargets((t) => resolve(t || [])),
    );
  } catch {}
  return {
    resolvedTab: tab
      ? {
          id: tab.id,
          windowId: tab.windowId,
          url: tab.url,
          status: tab.status,
          title: tab.title,
          active: tab.active,
        }
      : null,
    activeTab: active
      ? {
          id: active.id,
          windowId: active.windowId,
          url: active.url,
          status: active.status,
          title: active.title,
          active: active.active,
        }
      : null,
    attachedTabs: attachedTabIds(),
    cdpTargets: targets.map((t) => ({
      id: t.id,
      tabId: t.tabId,
      type: t.type,
      url: t.url,
      attached: t.attached,
      extensionId: t.extensionId,
    })),
  };
}

function targetMetaSuffix(meta: unknown): string {
  return `\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`;
}

const completeDebuggerDetach = async (
  tabId: number,
  transition: DetachingDebugger,
): Promise<void> => {
  try {
    await chrome.debugger.detach(transition.session.debuggee);
  } catch (error) {
    if (debuggerStates.get(tabId) === transition) {
      if (transition.detachedByEvent || isDebuggerSessionLost(error)) {
        debuggerStates.delete(tabId);
        return;
      }
      debuggerStates.set(tabId, { tag: "attached", session: transition.session });
    }
    throw error;
  }
  if (debuggerStates.get(tabId) === transition) debuggerStates.delete(tabId);
};

const beginDebuggerDetach = (tabId: number, session: AttachedTab): Promise<void> => {
  if (session.navigation) {
    settleNavigation(
      session.navigation,
      new Error(`Chrome debugger detached during navigation on tab ${tabId}`),
    );
  }
  const completion = deferred<void>();
  const transition: DetachingDebugger = {
    tag: "detaching",
    session,
    completion: completion.promise,
    detachedByEvent: false,
  };
  debuggerStates.set(tabId, transition);
  void completeDebuggerDetach(tabId, transition).then(
    () => completion.resolve(undefined),
    completion.reject,
  );
  return completion.promise;
};

async function detachDebugger(tabId: number): Promise<void> {
  while (true) {
    const state = debuggerStates.get(tabId);
    if (!state) return;
    if (state.tag === "attached") return beginDebuggerDetach(tabId, state.session);
    if (state.tag === "detaching") return state.completion;
    try {
      await state.completion;
    } catch {
      return;
    }
  }
}

export async function detachAllDebuggers(): Promise<void> {
  const ids = Array.from(debuggerStates.keys());
  await Promise.all(ids.map(detachDebugger));
}

export function handleDebuggerDetach(
  source: chrome.debugger.Debuggee,
  reason: `${chrome.debugger.DetachReason}`,
): void {
  if (source.tabId !== undefined) {
    const state = debuggerStates.get(source.tabId);
    if (state?.tag === "attached") {
      if (state.session.navigation) {
        settleNavigation(
          state.session.navigation,
          new Error(`Chrome debugger detached during navigation on tab ${source.tabId}`),
        );
      }
      debuggerStates.delete(source.tabId);
    } else if (state) state.detachedByEvent = true;
  }
  if (reason === "canceled_by_user") {
    console.warn(
      `[pi-chrome] debugger canceled by user on tab ${source.tabId}; Chrome input will reattach on next call`,
    );
  }
}

export function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  if (source.tabId === undefined || method !== "Page.lifecycleEvent" || !params) return;
  const session = attachedSession(source.tabId);
  const transition = session?.navigation;
  if (!transition) return;
  const event = params as Partial<CdpPageLifecycleEvent>;
  if (
    typeof event.frameId !== "string" ||
    typeof event.loaderId !== "string" ||
    typeof event.name !== "string"
  ) {
    return;
  }
  applyNavigationEvent(transition, {
    frameId: event.frameId,
    loaderId: event.loaderId,
    name: event.name,
  });
}

export async function detachExpiredDebuggers(now: number): Promise<void> {
  const expired: Array<number> = [];
  for (const [tabId, state] of debuggerStates) {
    if (
      state.tag === "attached" &&
      state.session.navigation === undefined &&
      state.session.activeCommands === 0 &&
      (state.session.navigationInitScript !== undefined || state.session.detachAt < now)
    ) {
      expired.push(tabId);
    }
  }
  await Promise.all(expired.map(detachDebugger));
}

function cdpRaw<Method extends CdpMethod>(
  tabId: number,
  method: Method,
  params: CdpCommandParams,
): Promise<CdpCommandResult<Method>>;
function cdpRaw(
  tabId: number,
  method: CdpMethod,
  params: CdpCommandParams,
): Promise<object | undefined> {
  const entry = attachedSession(tabId);
  if (!entry) {
    return Promise.reject(new Error(`pi-chrome has no debugger ownership record for tab ${tabId}`));
  }
  entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
  entry.activeCommands += 1;
  const debuggee = entry.debuggee;
  return new Promise<object | undefined>((resolve, reject) => {
    try {
      chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
        entry.activeCommands -= 1;
        if (chrome.runtime.lastError)
          reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
        else resolve(result);
      });
    } catch (error) {
      entry.activeCommands -= 1;
      reject(error);
    }
  });
}

export function executeScript<Args extends Array<unknown>, Result>(
  options: chrome.scripting.ScriptInjection<Args, Result>,
): Promise<Array<ScriptExecutionResult<Awaited<Result>>>>;
export function executeScript<Args extends Array<unknown>, Result>(
  options: chrome.scripting.ScriptInjection<Args, Result>,
) {
  return chrome.scripting.executeScript(options);
}

// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets(
  tabId: number,
): Promise<Array<chrome.debugger.TargetInfo>> {
  try {
    const targets = await new Promise<Array<chrome.debugger.TargetInfo>>((resolve) =>
      chrome.debugger.getTargets((t) => resolve(t || [])),
    );
    return targets.filter((t) => {
      if (t.tabId !== tabId) return false;
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets: ReadonlyArray<chrome.debugger.TargetInfo>): string | null {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    const extensionId = m?.[1];
    if (extensionId && extensionId !== chrome.runtime.id) return extensionId;
  }
  return null;
}

export function cdp<Method extends CdpMethod>(
  tabId: number,
  method: Method,
  params: CdpCommandParams,
): Promise<CdpCommandResult<Method>>;
export async function cdp(
  tabId: number,
  method: CdpMethod,
  params: CdpCommandParams,
): Promise<object | undefined> {
  const session = attachedSession(tabId);
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const message = errorText(error);
    if (session && attachedSession(tabId) === session && isDebuggerSessionLost(error)) {
      await detachDebugger(tabId);
    }

    const foreignExtensionBlocked =
      /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(message);
    if (foreignExtensionBlocked && method.startsWith("Input.")) {
      const targets = await findForeignExtensionTargets(tabId);
      const extensionId = extractForeignExtId(targets) || "unknown";
      throw new Error(
        `Another Chrome extension (${extensionId}) blocked input on this page. ` +
          "The input command was not replayed because its outcome is unknown; close the overlay before issuing a new command.",
        { cause: error },
      );
    }
    throw error;
  }
}

// Page.addScriptToEvaluateOnNewDocument registrations and their identifiers belong to the
// chrome.debugger Page-domain session. Keep that state on the same owner record: detach destroys
// the registration in Chrome and deleting the record atomically forgets its unusable identifier.
const navigateTabOwned = async (request: NavigateTabRequest): Promise<NavigationCompletion> => {
  const { tabId, url, milestone, timeoutMs, initScriptSource } = request;
  const session = await attachDebugger(tabId);
  if (session.navigation) {
    throw new Error(`Chrome tab ${tabId} retained an unreleased navigation owner`);
  }

  const transition: NavigationTransition = {
    generation: globalThis.crypto.randomUUID(),
    completion: deferred<void>(),
    earlyEventKeys: new Set(),
    settled: false,
  };
  void transition.completion.promise.catch(() => undefined);
  return withNavigationDeadline(tabId, transition, timeoutMs, () =>
    withResourceLease(
      async () => {
        session.navigation = transition;
        return transition;
      },
      async () => {
        await cdp(tabId, "Page.enable", {});
        await cdp(tabId, "Page.setLifecycleEventsEnabled", { enabled: true });
        if (attachedSession(tabId) !== session || session.navigation !== transition) {
          throw new Error(`Chrome debugger detached before navigation on tab ${tabId}`);
        }
        await installNavigationInitScript(tabId, session, initScriptSource);
        const result = await cdp(tabId, "Page.navigate", { url });
        if (attachedSession(tabId) !== session || session.navigation !== transition) {
          throw new Error(`Chrome debugger detached while navigating tab ${tabId}`);
        }
        if (typeof result.frameId !== "string" || result.frameId.length === 0) {
          throw new Error("Chrome navigation did not return a main frame id");
        }
        if (result.errorText) throw new Error(`Chrome navigation failed: ${result.errorText}`);
        if (result.isDownload) throw new Error("Chrome navigation became a download");
        if (!result.loaderId) {
          return {
            kind: "same-document",
            frameId: result.frameId,
            initScriptExecuted: false,
          };
        }

        bindNavigationTarget(transition, {
          frameId: result.frameId,
          loaderId: result.loaderId,
          milestone,
        });
        await waitForNavigation(transition, timeoutMs, tabId);
        return {
          kind: "new-document",
          frameId: result.frameId,
          loaderId: result.loaderId,
          milestone,
        };
      },
      async () => {
        try {
          await removeNavigationInitScript(tabId);
        } finally {
          if (attachedSession(tabId) === session && session.navigation === transition) {
            delete session.navigation;
          }
        }
      },
    ),
  );
};

export const navigateTab = (request: NavigateTabRequest): Promise<NavigationCompletion> =>
  withNavigationTurn(request.tabId, () => navigateTabOwned(request));

const installNavigationInitScript = async (
  tabId: number,
  session: AttachedTab,
  source: string,
): Promise<void> => {
  await removeNavigationInitScript(tabId);
  if (attachedSession(tabId) !== session) {
    throw new Error(`Chrome debugger detached before registering an init script for tab ${tabId}`);
  }
  session.navigationInitScript = { state: "registering" };
  const result = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source });
  if (attachedSession(tabId) !== session) {
    throw new Error(`Chrome debugger detached while registering an init script for tab ${tabId}`);
  }
  if (typeof result.identifier !== "string" || result.identifier.length === 0) {
    throw new Error("Chrome did not return an identifier for the registered init script");
  }
  session.navigationInitScript = { state: "registered", identifier: result.identifier };
};

async function removeNavigationInitScript(tabId: number): Promise<void> {
  const session = attachedSession(tabId);
  const lease = session?.navigationInitScript;
  if (!session || !lease) return;

  if (lease.state === "registering") {
    await detachDebugger(tabId);
    return;
  }

  try {
    await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", {
      identifier: lease.identifier,
    });
  } catch (error) {
    // A detached Page-domain session has already discarded its registrations. Likewise, Chrome's
    // unknown-identifier response proves the registration is absent. Any other failure resets the
    // whole Page-domain session; retaining a live registration would widen a command-scoped script
    // into an unbounded future-navigation hook.
    if (attachedSession(tabId) !== session || isUnknownInitScript(error)) {
      if (attachedSession(tabId) === session) delete session.navigationInitScript;
      return;
    }
    try {
      await detachDebugger(tabId);
    } catch (detachError) {
      throw new AggregateError(
        [error, detachError],
        `Chrome init-script removal and debugger reset both failed for tab ${tabId}`,
      );
    }
    return;
  }

  if (attachedSession(tabId) === session) delete session.navigationInitScript;
}

// cdpEval: evaluate a JavaScript expression string in the page's MAIN world via CDP
// Runtime.evaluate. Runtime.evaluate is a DevTools protocol command and is NOT subject to
// the page's Content-Security-Policy, so it works on pages that ship `script-src 'self'`
// without `'unsafe-eval'` (which blocks `eval`/`new Function`). Ensures the debugger is
// attached first. Returns the raw CDP result ({ result, exceptionDetails }).
export async function cdpEval(
  tabId: number,
  expression: string,
  opts: CdpCommandParams = {},
): Promise<CdpRuntimeEvaluateResult> {
  await attachDebugger(tabId);
  return cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...opts,
  });
}

export function cdpExceptionText(details: CdpExceptionDetails | null | undefined): string {
  if (!details) return "";
  const value = details.exception?.description ?? details.exception?.value ?? details.text ?? "";
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

export function pointerOrigin(
  tabId: number,
  fallbackX: number,
  fallbackY: number,
): { x: number; y: number } {
  const pointer = attachedSession(tabId)?.pointer;
  return { x: pointer?.x ?? fallbackX, y: pointer?.y ?? fallbackY };
}

export function recordPointer(tabId: number, x: number, y: number): void {
  const entry = attachedSession(tabId);
  if (entry) entry.pointer = { x, y };
}
