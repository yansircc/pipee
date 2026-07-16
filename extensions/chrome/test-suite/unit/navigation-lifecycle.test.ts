import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { COMMAND_DEADLINES_MS } from "../../src/protocol/bridge-contract.js";
import type { WireCommand } from "../../src/protocol/schema.js";

const targetMocks = vi.hoisted(() => ({
  bringToFront: vi.fn(),
  cleanupAutomationTarget: vi.fn(),
  createNewAutomationTarget: vi.fn(),
  formatTab: vi.fn(async (tab) => tab),
  getOwnedAutomationTarget: vi.fn(),
  getTabByParams: vi.fn(async () => ({
    id: 7,
    windowId: 1,
    url: "https://before.test/",
  })),
  groupTab: vi.fn(),
  sessionKeyOf: vi.fn(() => "session:navigation-lifecycle"),
}));

vi.mock("../../src/browser/platform-targets.js", () => targetMocks);

const initScripts = new Set<string>();
const cdpCommands: Array<{
  tabId: number | undefined;
  method: string;
  params: Record<string, unknown>;
}> = [];

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

let nextInitScriptId = 1;
let removeInitScriptError: Error | undefined;
let sendCommandError: Error | undefined;
let attachError: Error | undefined;
let detachError: Error | undefined;
let attachBarrier: Deferred | undefined;
let detachBarrier: Deferred | undefined;
let heldSendCommand: ((result: unknown) => void) | undefined;
let holdSendCommand = false;
let heldPageNavigate: ((result: unknown) => void) | undefined;
let holdPageNavigate = false;
let getTargetsCalls = 0;
let attachCalls = 0;
const attachedTabCalls: Array<number | undefined> = [];
let detachCalls = 0;
let debuggerTargets: Array<chrome.debugger.TargetInfo> = [];
let pageNavigateResult: Record<string, unknown> = {};
let pageNavigateError: Error | undefined;
let beforePageNavigate: (() => void) | undefined;

const chromeMock = {
  runtime: {
    id: "unit-extension",
    getManifest: () => ({ version: "0.16.0" }),
    lastError: undefined as { message: string } | undefined,
  },
  debugger: {
    getTargets: (callback: (targets: Array<chrome.debugger.TargetInfo>) => void) => {
      getTargetsCalls += 1;
      callback(debuggerTargets);
    },
    attach: async (debuggee: chrome.debugger.Debuggee) => {
      attachCalls += 1;
      attachedTabCalls.push(debuggee.tabId);
      await attachBarrier?.promise;
      if (attachError) throw attachError;
    },
    detach: async () => {
      detachCalls += 1;
      await detachBarrier?.promise;
      if (detachError) throw detachError;
      initScripts.clear();
    },
    sendCommand: (
      debuggee: chrome.debugger.Debuggee,
      method: string,
      params: Record<string, unknown>,
      callback: (result: unknown) => void,
    ) => {
      cdpCommands.push({ tabId: debuggee.tabId, method, params });
      if (holdSendCommand) {
        heldSendCommand = callback;
        return;
      }
      if (sendCommandError) {
        chromeMock.runtime.lastError = { message: sendCommandError.message };
        callback(undefined);
        chromeMock.runtime.lastError = undefined;
        return;
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        const identifier = `init-script-${nextInitScriptId++}`;
        initScripts.add(identifier);
        callback({ identifier });
        return;
      }
      if (method === "Page.navigate") {
        beforePageNavigate?.();
        if (pageNavigateError) {
          chromeMock.runtime.lastError = { message: pageNavigateError.message };
          callback(undefined);
          chromeMock.runtime.lastError = undefined;
          return;
        }
        if (holdPageNavigate) {
          heldPageNavigate = callback;
          return;
        }
        callback(pageNavigateResult);
        return;
      }
      if (method === "Page.removeScriptToEvaluateOnNewDocument") {
        if (removeInitScriptError) {
          chromeMock.runtime.lastError = { message: removeInitScriptError.message };
          callback(undefined);
          chromeMock.runtime.lastError = undefined;
          return;
        }
        initScripts.delete(String(params.identifier));
      }
      callback({});
    },
  },
  tabs: {
    get: async () => ({ id: 7, windowId: 1, url: "https://before.test/" }),
  },
};

let dispatchBrowserCommand: (command: WireCommand) => Promise<unknown>;
let attachDebugger: (tabId: number) => Promise<unknown>;
let cdp: (
  tabId: number,
  method: "Input.dispatchMouseEvent",
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
let detachAllDebuggers: () => Promise<void>;
let detachExpiredDebuggers: (now: number) => Promise<void>;
let navigateTab: typeof import("../../src/browser/platform-cdp.js").navigateTab;
let handleDebuggerDetach: (
  source: chrome.debugger.Debuggee,
  reason: `${chrome.debugger.DetachReason}`,
) => void;
let handleDebuggerEvent: (
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
) => void;

beforeAll(async () => {
  Object.assign(globalThis, { chrome: chromeMock });
  ({ dispatchBrowserCommand } = await import("../../src/browser/platform.js"));
  ({
    attachDebugger,
    cdp,
    detachAllDebuggers,
    detachExpiredDebuggers,
    handleDebuggerDetach,
    handleDebuggerEvent,
    navigateTab,
  } = await import("../../src/browser/platform-cdp.js"));
});

beforeEach(async () => {
  attachError = undefined;
  detachError = undefined;
  attachBarrier = undefined;
  detachBarrier = undefined;
  await detachAllDebuggers();
  initScripts.clear();
  cdpCommands.length = 0;
  nextInitScriptId = 1;
  removeInitScriptError = undefined;
  sendCommandError = undefined;
  heldSendCommand = undefined;
  holdSendCommand = false;
  heldPageNavigate = undefined;
  holdPageNavigate = false;
  getTargetsCalls = 0;
  attachCalls = 0;
  attachedTabCalls.length = 0;
  detachCalls = 0;
  debuggerTargets = [];
  pageNavigateResult = {};
  pageNavigateError = undefined;
  beforePageNavigate = undefined;
  targetMocks.getTabByParams.mockReset();
  targetMocks.getTabByParams.mockResolvedValue({
    id: 7,
    windowId: 1,
    url: "https://before.test/",
  });
  targetMocks.formatTab.mockClear();
});

afterEach(() => vi.useRealTimers());

it("never detaches an unowned debugger before attaching", async () => {
  await attachDebugger(7);

  expect(getTargetsCalls).toBe(0);
  expect(detachCalls).toBe(0);
});

it("fails when another debugger owns the tab without detaching it", async () => {
  attachError = new Error("Another debugger is already attached to the tab");

  await expect(attachDebugger(7)).rejects.toThrow(
    "Another debugger is attached to tab 7; pi-chrome will not detach or replace it",
  );
  expect(detachCalls).toBe(0);
});

it("waits for a pending detach and performs exactly one fresh attach", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const previous = await attachDebugger(7);
  detachBarrier = deferred();

  const detaching = detachExpiredDebuggers(16_000);
  expect(detachCalls).toBe(1);

  const first = attachDebugger(7);
  const second = attachDebugger(7);
  let attached = false;
  void first.then(() => {
    attached = true;
  });
  await Promise.resolve();
  expect(attachCalls).toBe(1);
  expect(attached).toBe(false);
  await expect(
    cdp(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 }),
  ).rejects.toThrow("no debugger ownership record");
  await attachDebugger(8);
  expect(attachedTabCalls).toEqual([7, 8]);

  detachBarrier.resolve();
  await detaching;
  const [firstSession, secondSession] = await Promise.all([first, second]);
  expect(attachedTabCalls).toEqual([7, 8, 7]);
  expect(firstSession).toBe(secondSession);
  expect(firstSession).not.toBe(previous);
  now.mockRestore();
});

it("retains the owned session when debugger detach genuinely fails", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const owner = await attachDebugger(7);
  detachError = new Error("detach denied");

  await expect(detachExpiredDebuggers(16_000)).rejects.toThrow("detach denied");
  const retained = await attachDebugger(7);
  expect(retained).toBe(owner);
  expect(attachCalls).toBe(1);

  detachError = undefined;
  await detachAllDebuggers();
  now.mockRestore();
});

it("clears ownership when detach proves the debugger no longer exists", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  await attachDebugger(7);
  detachError = new Error("Debugger is not attached to the tab");

  await detachExpiredDebuggers(16_000);
  detachError = undefined;
  await attachDebugger(7);
  expect(attachCalls).toBe(2);
  now.mockRestore();
});

it("keeps onDetach inside the pending transition until detach settles", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  await attachDebugger(7);
  detachBarrier = deferred();
  detachError = new Error("detach denied after Chrome reported target closure");

  const detaching = detachExpiredDebuggers(16_000);
  handleDebuggerDetach({ tabId: 7 }, "target_closed");
  const waiting = attachDebugger(7);
  await Promise.resolve();
  expect(attachCalls).toBe(1);

  detachBarrier.resolve();
  await detaching;
  await waiting;
  expect(attachCalls).toBe(2);
  detachError = undefined;
  now.mockRestore();
});

it("does not publish an attaching session invalidated by onDetach", async () => {
  attachBarrier = deferred();
  const attaching = attachDebugger(7);
  handleDebuggerDetach({ tabId: 7 }, "target_closed");

  attachBarrier.resolve();
  await expect(attaching).rejects.toThrow("detached while attaching");
  attachBarrier = undefined;
  await attachDebugger(7);
  expect(attachCalls).toBe(2);
});

it("does not replay a CDP command after a detached-session callback", async () => {
  await attachDebugger(7);
  sendCommandError = new Error("Debugger is not attached");

  await expect(
    cdp(7, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20 }),
  ).rejects.toThrow("Debugger is not attached");
  expect(cdpCommands.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(1);
});

it("does not let a stale command callback detach a replacement session", async () => {
  await attachDebugger(7);
  holdSendCommand = true;
  const staleCommand = cdp(7, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });

  handleDebuggerDetach({ tabId: 7 }, "target_closed");
  const replacement = await attachDebugger(7);
  chromeMock.runtime.lastError = { message: "Debugger is not attached" };
  heldSendCommand?.(undefined);
  chromeMock.runtime.lastError = undefined;

  await expect(staleCommand).rejects.toThrow("Debugger is not attached");
  expect(await attachDebugger(7)).toBe(replacement);
  expect(attachCalls).toBe(2);
  expect(detachCalls).toBe(0);
});

it("keeps the command occupied until a non-cancellable CDP callback settles", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  await attachDebugger(7);
  holdSendCommand = true;
  const pending = cdp(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  let settled = false;
  void pending.finally(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(60_000);
  await detachExpiredDebuggers(Date.now());
  expect(settled).toBe(false);
  expect(detachCalls).toBe(0);
  heldSendCommand?.({});
  await pending;
  expect(settled).toBe(true);
  await detachExpiredDebuggers(Date.now());
  expect(detachCalls).toBe(1);
});

it("reports only a foreign extension target attached to the same tab", async () => {
  await attachDebugger(7);
  debuggerTargets = [
    {
      id: "unrelated",
      tabId: 8,
      type: "other",
      url: "chrome-extension://aaaaaaaa/popup.html",
      attached: true,
      extensionId: "aaaaaaaa",
      title: "Unrelated",
    },
    {
      id: "related",
      tabId: 7,
      type: "other",
      url: "chrome-extension://bbbbbbbb/popup.html",
      attached: true,
      extensionId: "bbbbbbbb",
      title: "Related",
    },
  ];
  sendCommandError = new Error("Cannot access a chrome-extension:// URL of different extension");

  const failure = await cdp(7, "Input.dispatchMouseEvent", { type: "mousePressed" }).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("bbbbbbbb");
  expect((failure as Error).message).not.toContain("aaaaaaaa");
  expect(cdpCommands.filter(({ method }) => method === "Input.dispatchMouseEvent")).toHaveLength(1);
});

it("refreshes the debugger lease on every CDP command", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  await attachDebugger(7);
  now.mockReturnValue(14_000);
  await cdp(7, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });

  await detachExpiredDebuggers(16_000);
  expect(detachCalls).toBe(0);
  now.mockRestore();
});

const emitLifecycle = (tabId: number, frameId: string, loaderId: string, name: string): void => {
  handleDebuggerEvent({ tabId }, "Page.lifecycleEvent", { frameId, loaderId, name });
};

it("buffers the exact commit event that arrives before Page.navigate returns", async () => {
  pageNavigateResult = { frameId: "main-frame", loaderId: "new-loader" };
  beforePageNavigate = () => emitLifecycle(7, "main-frame", "new-loader", "init");

  await expect(
    navigateTab({
      tabId: 7,
      url: "https://after.test/",
      milestone: "commit",
      timeoutMs: 1_000,
      initScriptSource: "globalThis.__test = true",
    }),
  ).resolves.toEqual({
    kind: "new-document",
    frameId: "main-frame",
    loaderId: "new-loader",
    milestone: "commit",
  });
});

it.each([
  {
    ignoredName: "load",
    acceptedName: "init",
    milestone: "commit",
  },
  {
    ignoredName: "init",
    acceptedName: "load",
    milestone: "load",
  },
] as const)(
  "waits for the exact $milestone event from the Page.navigate generation",
  async ({ ignoredName, acceptedName, milestone }) => {
    pageNavigateResult = { frameId: "main-frame", loaderId: "new-loader" };
    const navigation = navigateTab({
      tabId: 7,
      url: "https://after.test/",
      milestone,
      timeoutMs: 1_000,
      initScriptSource: "globalThis.__test = true",
    });
    let settled = false;
    void navigation.then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(cdpCommands.some(({ method }) => method === "Page.navigate")).toBe(true),
    );

    emitLifecycle(7, "main-frame", "old-loader", acceptedName);
    emitLifecycle(7, "sub-frame", "new-loader", acceptedName);
    emitLifecycle(7, "main-frame", "new-loader", ignoredName);
    await Promise.resolve();
    expect(settled).toBe(false);

    emitLifecycle(7, "main-frame", "new-loader", acceptedName);
    await expect(navigation).resolves.toEqual({
      kind: "new-document",
      frameId: "main-frame",
      loaderId: "new-loader",
      milestone,
    });
  },
);

it("reports same-document navigation without claiming the init script executed", async () => {
  pageNavigateResult = { frameId: "main-frame" };

  await expect(
    navigateTab({
      tabId: 7,
      url: "https://after.test/#section",
      milestone: "load",
      timeoutMs: 1_000,
      initScriptSource: "globalThis.__test = true",
    }),
  ).resolves.toEqual({
    kind: "same-document",
    frameId: "main-frame",
    initScriptExecuted: false,
  });
});

it("fails closed when lifecycle events outgrow the command-scoped early buffer", async () => {
  pageNavigateResult = { frameId: "main-frame", loaderId: "new-loader" };
  beforePageNavigate = () => {
    for (let index = 0; index <= 256; index += 1) {
      emitLifecycle(7, "main-frame", `unrelated-loader-${index}`, "init");
    }
  };

  await expect(
    navigateTab({
      tabId: 7,
      url: "https://after.test/",
      milestone: "commit",
      timeoutMs: 1_000,
      initScriptSource: "globalThis.__test = true",
    }),
  ).rejects.toThrow("exceeded 256 buffered lifecycle events");
});

it("serializes concurrent navigation before it can touch the active init script", async () => {
  pageNavigateResult = { frameId: "main-frame", loaderId: "new-loader" };
  holdPageNavigate = true;
  const first = navigateTab({
    tabId: 7,
    url: "https://first.test/",
    milestone: "commit",
    timeoutMs: 1_000,
    initScriptSource: "globalThis.__owner = 'first'",
  });
  await vi.waitFor(() => expect(heldPageNavigate).toBeTypeOf("function"));
  const commandsBeforeSecond = cdpCommands.length;
  await detachExpiredDebuggers(Number.MAX_SAFE_INTEGER);
  expect(detachCalls).toBe(0);

  const second = navigateTab({
    tabId: 7,
    url: "https://second.test/",
    milestone: "commit",
    timeoutMs: 1_000,
    initScriptSource: "globalThis.__owner = 'second'",
  });
  await Promise.resolve();
  expect(cdpCommands).toHaveLength(commandsBeforeSecond);
  expect(
    cdpCommands.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument"),
  ).toHaveLength(1);
  expect(
    cdpCommands.find(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument")?.params
      .source,
  ).toBe("globalThis.__owner = 'first'");

  holdPageNavigate = false;
  beforePageNavigate = () => emitLifecycle(7, "main-frame", "new-loader", "init");
  heldPageNavigate?.(pageNavigateResult);
  emitLifecycle(7, "main-frame", "new-loader", "init");
  await expect(first).resolves.toMatchObject({ milestone: "commit" });
  await expect(second).resolves.toMatchObject({ milestone: "commit" });
  expect(initScripts.size).toBe(0);
});

it("resets a navigation whose CDP callback outlives the whole transaction deadline", async () => {
  vi.useFakeTimers();
  holdSendCommand = true;
  const timedOut = navigateTab({
    tabId: 7,
    url: "https://stalled.test/",
    milestone: "commit",
    timeoutMs: 10,
    initScriptSource: "globalThis.__owner = 'stalled'",
  });
  await vi.waitFor(() => expect(heldSendCommand).toBeTypeOf("function"));
  const staleCallback = heldSendCommand;
  const rejected = expect(timedOut).rejects.toThrow("Navigation transaction timed out");

  await vi.advanceTimersByTimeAsync(10 + COMMAND_DEADLINES_MS.navigateOverhead);
  await rejected;
  expect(detachCalls).toBe(1);

  holdSendCommand = false;
  pageNavigateResult = { frameId: "main-frame", loaderId: "replacement-loader" };
  beforePageNavigate = () => emitLifecycle(7, "main-frame", "replacement-loader", "init");
  await expect(
    navigateTab({
      tabId: 7,
      url: "https://replacement.test/",
      milestone: "commit",
      timeoutMs: 1_000,
      initScriptSource: "globalThis.__owner = 'replacement'",
    }),
  ).resolves.toMatchObject({ loaderId: "replacement-loader" });
  expect(attachCalls).toBe(2);

  staleCallback?.({});
  await Promise.resolve();
  expect(await attachDebugger(7)).toBeDefined();
  expect(attachCalls).toBe(2);
});

const navigationCommand = (id: string): WireCommand => ({
  id,
  domain: "page",
  session: {
    key: "session:navigation-lifecycle",
    groupTitle: "Navigation lifecycle",
    foreground: false,
  },
  call: {
    operation: {
      kind: "navigate",
      url: "https://after.test/",
      initScript: "globalThis.__navigationLifecycle = true",
      waitUntilLoad: true,
    },
  },
});

it("pins a selector-resolved navigation to one exact tab for its whole lifecycle", async () => {
  targetMocks.getTabByParams
    .mockResolvedValueOnce({ id: 7, windowId: 1, url: "https://before.test/" })
    .mockResolvedValue({ id: 8, windowId: 2, url: "https://drifted.test/" });
  pageNavigateResult = { frameId: "main-frame", loaderId: "new-loader" };
  beforePageNavigate = () => emitLifecycle(7, "main-frame", "new-loader", "init");
  const command: WireCommand = {
    id: "exact-tab-navigation",
    domain: "page",
    session: {
      key: "session:navigation-lifecycle",
      groupTitle: "Navigation lifecycle",
      foreground: false,
    },
    call: {
      target: { by: "url", value: "before.test" },
      operation: {
        kind: "navigate",
        url: "https://after.test/",
        waitUntilLoad: false,
      },
    },
  };

  await expect(dispatchBrowserCommand(command)).resolves.toMatchObject({ id: 7, windowId: 1 });

  expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
  expect(cdpCommands.every(({ tabId }) => tabId === 7)).toBe(true);
  expect(cdpCommands.find(({ method }) => method === "Page.navigate")?.params).toEqual({
    url: "https://after.test/",
  });
  expect(targetMocks.formatTab).toHaveBeenCalledWith(
    expect.objectContaining({ id: 7, windowId: 1 }),
  );
  expect(initScripts.size).toBe(0);
});

it("removes the one-shot init script when Page.navigate rejects", async () => {
  const command = navigationCommand("navigate-with-init-script");
  pageNavigateError = new Error("navigation rejected");

  const failure = await dispatchBrowserCommand(command).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    name: "BrowserOutcomeUnknown",
  });
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("navigation rejected");

  expect(initScripts.size).toBe(0);
  expect(cdpCommands.map(({ method }) => method)).toEqual([
    "Page.enable",
    "Page.setLifecycleEventsEnabled",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.navigate",
    "Page.removeScriptToEvaluateOnNewDocument",
  ]);
  expect(cdpCommands[2]?.params.source).toContain("instrumentationInstalled");
  expect(cdpCommands[2]?.params.source).toContain("globalThis.__navigationLifecycle = true");
  expect(cdpCommands.at(-1)?.params).toEqual({ identifier: "init-script-1" });
  expect(cdpCommands.every(({ tabId }) => tabId === 7)).toBe(true);
  expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
});

it("arms early capture only inside an explicitly dispatched Pi navigation", async () => {
  const command = {
    id: "navigate-with-early-capture",
    domain: "page",
    session: {
      key: "session:navigation-lifecycle",
      groupTitle: "Navigation lifecycle",
      foreground: false,
    },
    call: {
      target: { by: "id", value: 7 },
      operation: {
        kind: "navigate",
        url: "https://after.test/",
        waitUntilLoad: false,
      },
    },
  } as WireCommand;

  pageNavigateError = new Error("navigation rejected");
  await expect(dispatchBrowserCommand(command)).rejects.toThrow("navigation rejected");

  expect(cdpCommands.map(({ method }) => method)).toEqual([
    "Page.enable",
    "Page.setLifecycleEventsEnabled",
    "Page.addScriptToEvaluateOnNewDocument",
    "Page.navigate",
    "Page.removeScriptToEvaluateOnNewDocument",
  ]);
  expect(cdpCommands[2]?.params.source).toContain("instrumentationInstalled");
  expect(initScripts.size).toBe(0);
});

it("resets the debugger when direct init-script removal fails", async () => {
  const command = navigationCommand("navigate-with-remove-failure");

  pageNavigateError = new Error("navigation rejected");
  removeInitScriptError = new Error("remove failed");
  await expect(dispatchBrowserCommand(command)).rejects.toThrow("navigation rejected");
  expect(initScripts.size).toBe(0);
  expect(detachCalls).toBe(1);

  removeInitScriptError = undefined;
  await expect(
    dispatchBrowserCommand({ ...command, id: "navigate-after-remove-failure" }),
  ).rejects.toThrow("navigation rejected");

  expect(initScripts.size).toBe(0);
  expect(attachCalls).toBe(2);
  expect(
    cdpCommands.filter(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument"),
  ).toHaveLength(2);
});

it("preserves navigation, removal, and debugger-reset failures and quarantines the lease", async () => {
  pageNavigateError = new Error("navigation rejected");
  removeInitScriptError = new Error("remove failed");
  detachError = new Error("detach denied");

  const failure = await dispatchBrowserCommand(
    navigationCommand("navigate-with-total-cleanup-failure"),
  ).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({ name: "BrowserOutcomeUnknown" });
  const useAndRelease = (failure as Error & { cause: AggregateError }).cause;
  expect(useAndRelease).toBeInstanceOf(AggregateError);
  expect(useAndRelease.errors[0]).toMatchObject({
    message: expect.stringContaining("navigation rejected"),
  });
  expect(useAndRelease.errors[1]).toBeInstanceOf(AggregateError);
  expect((useAndRelease.errors[1] as AggregateError).errors).toEqual([
    expect.objectContaining({ message: expect.stringContaining("remove failed") }),
    expect.objectContaining({ message: "detach denied" }),
  ]);
  expect([...initScripts]).toEqual(["init-script-1"]);

  detachError = undefined;
  removeInitScriptError = undefined;
  pageNavigateError = new Error("second navigation rejected");
  await expect(
    dispatchBrowserCommand(navigationCommand("navigate-after-total-cleanup-failure")),
  ).rejects.toThrow("second navigation rejected");
  expect(initScripts.size).toBe(0);
  expect(attachCalls).toBe(2);
});

it("starts the next navigation with a fresh init registry after debugger detach", async () => {
  beforePageNavigate = () => {
    initScripts.clear();
    handleDebuggerDetach({ tabId: 7 }, "target_closed");
  };

  await expect(dispatchBrowserCommand(navigationCommand("navigate-before-detach"))).rejects.toThrow(
    "detached while navigating",
  );
  expect(initScripts.size).toBe(0);

  beforePageNavigate = undefined;
  pageNavigateError = new Error("navigation rejected");
  await expect(dispatchBrowserCommand(navigationCommand("navigate-after-detach"))).rejects.toThrow(
    "navigation rejected",
  );

  expect(
    cdpCommands.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument"),
  ).toHaveLength(2);
  expect(cdpCommands.at(-1)?.params).toEqual({ identifier: "init-script-2" });
  expect(initScripts.size).toBe(0);
});

it("treats Chrome's unknown init-script identifier as already removed", async () => {
  beforePageNavigate = () => {
    initScripts.clear();
    removeInitScriptError = new Error("No script with given id");
  };
  pageNavigateError = new Error("navigation rejected");

  await expect(
    dispatchBrowserCommand(navigationCommand("navigate-before-unknown-identifier")),
  ).rejects.toThrow("navigation rejected");

  removeInitScriptError = undefined;
  beforePageNavigate = undefined;
  await expect(
    dispatchBrowserCommand(navigationCommand("navigate-after-unknown-identifier")),
  ).rejects.toThrow("navigation rejected");

  expect(
    cdpCommands.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument"),
  ).toHaveLength(2);
  expect(cdpCommands.at(-1)).toMatchObject({
    tabId: 7,
    method: "Page.removeScriptToEvaluateOnNewDocument",
    params: { identifier: "init-script-2" },
  });
  expect(initScripts.size).toBe(0);
});
