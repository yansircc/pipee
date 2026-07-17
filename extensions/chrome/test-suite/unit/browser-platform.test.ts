import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  BRIDGE_ORIGIN,
  SCREENSHOT_LIMITS,
  SCREENSHOT_MAX_TILE_COUNT,
} from "../../src/protocol/bridge-contract.js";
import { TARGET_BOOTSTRAP_DOCUMENT_PATH } from "../../src/browser/extension-runtime-assets.js";
import { planFullPageTileGeometry } from "../../src/protocol/screenshot-geometry.js";
import type { WireCommand } from "../../src/protocol/schema.js";

type MockTab = {
  id: number;
  windowId: number;
  url: string;
  title: string;
  active: boolean;
  groupId: number;
};

type MockWindow = {
  id: number;
  type: "normal" | "popup";
  focused: boolean;
  incognito: boolean;
};

type MockGroup = {
  id: number;
  title: string;
  color: string;
  collapsed: boolean;
  windowId: number;
};

type TabResult = {
  readonly id: number;
  readonly windowId: number;
  readonly groupId: number;
  readonly group: { readonly title: string } | null;
};

const tabs = new Map<number, MockTab>();
const windows = new Map<number, MockWindow>();
const groups = new Map<number, MockGroup>();
const localStorage: Record<string, unknown> = {};
const sessionStorage: Record<string, unknown> = {};
const localGetKeys: Array<string | null> = [];
let nextTabId = 10;
let nextGroupId = 10;
let windowCreateCalls = 0;
let tabsQueryError: Error | undefined;
let tabsUpdateError: Error | undefined;
let tabsRemoveError: Error | undefined;
let localSetCalls = 0;
let localSetErrorOnCall: number | undefined;
let localRemoveError: Error | undefined;
let navigationGeneration = 0;
const navigationUrls: string[] = [];
const tabUpdates: Array<{
  readonly tabId: number;
  readonly update: Readonly<Record<string, unknown>>;
  readonly urlBefore: string;
}> = [];
let handleDebuggerEvent: typeof import("../../src/browser/platform.js").handleDebuggerEvent;
let primaryHandleDebuggerEvent: typeof import("../../src/browser/platform.js").handleDebuggerEvent;

const required = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);
  return value;
};

const userWindow: MockWindow = {
  id: 1,
  type: "normal",
  focused: true,
  incognito: false,
};
const userTab: MockTab = {
  id: 1,
  windowId: 1,
  url: "https://user.test/",
  title: "User",
  active: true,
  groupId: -1,
};

const targetBootstrapUrl = (nonce: string): string =>
  `chrome-extension://unit-extension/${TARGET_BOOTSTRAP_DOCUMENT_PATH}#${nonce}`;

const resetBrowserState = () => {
  tabs.clear();
  windows.clear();
  groups.clear();
  for (const key of Object.keys(localStorage)) delete localStorage[key];
  localGetKeys.length = 0;
  sessionStorage.piChromeBrowserEpoch ??= "browser-epoch:test";
  nextTabId = 10;
  nextGroupId = 10;
  windowCreateCalls = 0;
  tabsQueryError = undefined;
  tabsUpdateError = undefined;
  tabsRemoveError = undefined;
  localSetCalls = 0;
  localSetErrorOnCall = undefined;
  localRemoveError = undefined;
  navigationGeneration = 0;
  navigationUrls.length = 0;
  tabUpdates.length = 0;
  Object.assign(userWindow, { type: "normal", focused: true, incognito: false });
  Object.assign(userTab, {
    windowId: userWindow.id,
    url: "https://user.test/",
    title: "User",
    active: true,
    groupId: -1,
  });
  windows.set(userWindow.id, userWindow);
  tabs.set(userTab.id, userTab);
};

resetBrowserState();

const chromeMock = {
  runtime: {
    id: "unit-extension",
    getManifest: () => ({ version: "0.16.0" }),
    getURL: (path: string) => `chrome-extension://unit-extension/${path}`,
    lastError: undefined as { message: string } | undefined,
  },
  debugger: {
    attach: async () => undefined,
    detach: async () => undefined,
    getTargets: (callback: (targets: unknown[]) => void) => callback([]),
    sendCommand: (
      debuggee: chrome.debugger.Debuggee,
      method: string,
      params: Record<string, unknown>,
      callback: (result: unknown) => void,
    ) => {
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        callback({ identifier: "unit-navigation-script" });
        return;
      }
      if (method === "Page.navigate") {
        const tabId = required(debuggee.tabId, "Page.navigate requires a tab id");
        const tab = required(tabs.get(tabId), `No tab ${tabId}`);
        const frameId = `main-frame-${tabId}`;
        const loaderId = `loader-${++navigationGeneration}`;
        tab.url = String(params.url);
        navigationUrls.push(tab.url);
        callback({ frameId, loaderId });
        queueMicrotask(() => {
          handleDebuggerEvent({ tabId }, "Page.lifecycleEvent", {
            frameId,
            loaderId,
            name: "init",
          });
          handleDebuggerEvent({ tabId }, "Page.lifecycleEvent", {
            frameId,
            loaderId,
            name: "load",
          });
        });
        return;
      }
      callback({});
    },
  },
  storage: {
    local: {
      get: async (key: string | null) => {
        localGetKeys.push(key);
        return key === null
          ? { ...localStorage }
          : key in localStorage
            ? { [key]: localStorage[key] }
            : {};
      },
      set: async (value: Record<string, unknown>) => {
        localSetCalls += 1;
        if (localSetCalls === localSetErrorOnCall) throw new Error("local set failed");
        Object.assign(localStorage, value);
      },
      remove: async (key: string) => {
        if (localRemoveError) throw localRemoveError;
        delete localStorage[key];
      },
    },
    session: {
      get: async (key: string) => (key in sessionStorage ? { [key]: sessionStorage[key] } : {}),
      set: async (value: Record<string, unknown>) => Object.assign(sessionStorage, value),
      remove: async (key: string) => {
        delete sessionStorage[key];
      },
    },
  },
  windows: {
    create: async () => {
      windowCreateCalls += 1;
      throw new Error("owned targets must not create Chrome windows");
    },
    getAll: async ({ windowTypes }: { windowTypes?: string[] } = {}) =>
      [...windows.values()]
        .filter((window) => !windowTypes || windowTypes.includes(window.type))
        .map((window) => ({ ...window })),
    get: async (id: number) => {
      const window = windows.get(id);
      if (!window) return Promise.reject(new Error(`No window ${id}`));
      return { ...window };
    },
    update: async (id: number, update: Record<string, unknown>) => {
      const window = windows.get(id);
      if (!window) return Promise.reject(new Error(`No window ${id}`));
      Object.assign(window, update);
      return { ...window };
    },
    remove: async (id: number) => {
      windows.delete(id);
      for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
    },
  },
  tabs: {
    query: async () => {
      if (tabsQueryError) throw tabsQueryError;
      return [...tabs.values()].map((tab) => ({ ...tab }));
    },
    get: async (id: number) => {
      const tab = tabs.get(id);
      if (!tab) return Promise.reject(new Error(`No tab ${id}`));
      return { ...tab };
    },
    create: async ({ url, windowId }: { url: string; windowId?: number }) => {
      if (typeof windowId !== "number" || !windows.has(windowId)) {
        throw new Error("tabs.create requires an existing window in this test");
      }
      const tab = {
        id: nextTabId++,
        windowId,
        url,
        title: "",
        active: false,
        groupId: -1,
      };
      tabs.set(tab.id, tab);
      return { ...tab };
    },
    update: async (id: number, update: Record<string, unknown>) => {
      if (tabsUpdateError) throw tabsUpdateError;
      const tab = tabs.get(id)!;
      tabUpdates.push({ tabId: id, update: { ...update }, urlBefore: tab.url });
      Object.assign(tab, update);
      return { ...tab };
    },
    remove: async (id: number) => {
      if (tabsRemoveError) throw tabsRemoveError;
      tabs.delete(id);
      for (const [groupId] of groups) {
        if (![...tabs.values()].some((tab) => tab.groupId === groupId)) groups.delete(groupId);
      }
    },
    group: async ({ groupId, tabIds }: { groupId?: number; tabIds: number | number[] }) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      const firstId = required(ids[0], "tabs.group requires at least one tab id");
      const first = tabs.get(firstId);
      if (!first) throw new Error(`No tab ${firstId}`);
      const id = groupId ?? nextGroupId++;
      const group = groups.get(id) ?? {
        id,
        title: "",
        color: "grey",
        collapsed: false,
        windowId: first.windowId,
      };
      groups.set(id, group);
      for (const tabId of ids) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        tab.groupId = id;
        tab.windowId = group.windowId;
      }
      return id;
    },
    ungroup: async (tabIds: number | number[]) => {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        const tab = tabs.get(tabId);
        if (tab) tab.groupId = -1;
      }
    },
  },
  tabGroups: {
    query: async ({ windowId }: { windowId?: number } = {}) =>
      [...groups.values()]
        .filter((group) => windowId === undefined || group.windowId === windowId)
        .map((group) => ({ ...group })),
    get: async (id: number) => {
      const group = groups.get(id);
      if (!group) return Promise.reject(new Error(`No group ${id}`));
      return { ...group };
    },
    update: async (id: number, update: Record<string, unknown>) => {
      const group = groups.get(id);
      if (!group) return Promise.reject(new Error(`No group ${id}`));
      Object.assign(group, update);
      return { ...group };
    },
  },
};

let dispatchBrowserCommand: (command: WireCommand) => Promise<unknown>;
let handleAutomationTabRemoved: (
  tabId: number,
  removeInfo: chrome.tabs.OnRemovedInfo,
) => Promise<void>;
let projectBrowserCommand: (command: WireCommand) => {
  readonly domain: string;
  readonly operation: string;
  readonly effect: "read-only" | "may-mutate";
  readonly params: Readonly<Record<string, unknown>>;
};

beforeAll(async () => {
  Object.assign(globalThis, {
    chrome: chromeMock,
    __PI_CHROME_BRIDGE_URL__: BRIDGE_ORIGIN,
  });
  ({
    dispatchBrowserCommand,
    handleAutomationTabRemoved,
    handleDebuggerEvent,
    projectBrowserCommand,
  } = await import("../../src/browser/platform.js"));
  primaryHandleDebuggerEvent = handleDebuggerEvent;
});

beforeEach(() => {
  resetBrowserState();
  handleDebuggerEvent = primaryHandleDebuggerEvent;
});

const session = {
  key: "session:test",
  groupTitle: "Pi Session: test",
  foreground: false,
} as const;

const storedTargets = (): ReadonlyArray<Record<string, unknown>> =>
  (
    localStorage.piChromeAutomationTargets as
      | Record<string, ReadonlyArray<Record<string, unknown>>>
      | undefined
  )?.[session.key] ?? [];

const storedTarget = (): Record<string, unknown> | undefined => storedTargets()[0];

const navigate: WireCommand = {
  id: "navigate",
  domain: "page",
  session,
  call: {
    operation: {
      kind: "navigate",
      url: "https://automation.test/",
      waitUntilLoad: false,
    },
  },
};

it("constructs a finite bounded full-page capture plan", () => {
  expect(
    planFullPageTileGeometry(
      { width: 800, height: 2_001, viewportHeight: 1_000, dpr: 1 },
      SCREENSHOT_LIMITS,
    ),
  ).toEqual({
    ok: true,
    tiles: [
      { y: 0, height: 1_000 },
      { y: 1_000, height: 1_000 },
      { y: 2_000, height: 1 },
    ],
  });
  expect(
    planFullPageTileGeometry(
      { width: 800, height: 1_000, viewportHeight: 0, dpr: 1 },
      SCREENSHOT_LIMITS,
    ),
  ).toMatchObject({
    ok: false,
    message: expect.stringContaining("positive finite viewport height"),
  });
  expect(
    planFullPageTileGeometry(
      {
        width: 1,
        height: SCREENSHOT_MAX_TILE_COUNT + 1,
        viewportHeight: 1,
        dpr: 1,
      },
      SCREENSHOT_LIMITS,
    ),
  ).toMatchObject({
    ok: false,
    message: expect.stringContaining(`maximum is ${SCREENSHOT_MAX_TILE_COUNT}`),
  });
});

it.each([
  {
    name: "element target",
    command: {
      id: "inspect",
      domain: "page",
      session,
      call: {
        target: { by: "title", value: "Inbox" },
        operation: {
          kind: "inspect",
          element: { by: "selector", value: "#message" },
        },
      },
    },
    expected: {
      operation: "inspect",
      effect: "may-mutate",
      params: { titleFragment: "Inbox", selector: "#message" },
    },
  },
  {
    name: "wait condition",
    command: {
      id: "wait",
      domain: "page",
      session,
      call: {
        operation: {
          kind: "wait",
          condition: { by: "expression", value: "window.ready" },
        },
      },
    },
    expected: {
      operation: "wait",
      effect: "may-mutate",
      params: { conditionBy: "expression", conditionValue: "window.ready" },
    },
  },
  {
    name: "pointer target",
    command: {
      id: "click",
      domain: "input",
      session,
      call: {
        operation: { kind: "click", at: { by: "coordinate", x: 10, y: 20 } },
      },
    },
    expected: { operation: "click", effect: "may-mutate", params: { x: 10, y: 20 } },
  },
  {
    name: "drag endpoints",
    command: {
      id: "drag",
      domain: "input",
      session,
      call: {
        operation: {
          kind: "drag",
          from: { by: "uid", value: "el-1" },
          to: { by: "selector", value: "#drop" },
          steps: 8,
        },
      },
    },
    expected: {
      operation: "drag",
      effect: "may-mutate",
      params: { fromUid: "el-1", toSelector: "#drop", steps: 8 },
    },
  },
  {
    name: "key modifiers",
    command: {
      id: "key",
      domain: "input",
      session,
      call: {
        operation: {
          kind: "key",
          key: "Enter",
          modifiers: { control: true, shift: true },
        },
      },
    },
    expected: {
      operation: "key",
      effect: "may-mutate",
      params: {
        modifiers: { ctrlKey: true, shiftKey: true },
      },
    },
  },
] as const)("projects $name without losing protocol fields", ({ command, expected }) => {
  const projected = projectBrowserCommand(command as WireCommand);
  expect(projected.operation).toBe(expected.operation);
  expect(projected.effect).toBe(expected.effect);
  expect(projected.params).toMatchObject({
    sessionKey: session.key,
    sessionGroupTitle: session.groupTitle,
    foreground: session.foreground,
    ...expected.params,
  });
});

it("classifies only the minimum proven command set as read-only", () => {
  const list = projectBrowserCommand({
    id: "list-effect",
    domain: "tab",
    session,
    call: { op: "list" },
  });
  const version = projectBrowserCommand({
    id: "version-effect",
    domain: "system",
    session,
    call: { op: "version" },
  });
  const status = projectBrowserCommand({
    id: "status-effect",
    domain: "system",
    session,
    call: { op: "automation-status" },
  });
  const snapshot = projectBrowserCommand({
    id: "snapshot-effect",
    domain: "page",
    session,
    call: { operation: { kind: "snapshot" } },
  });

  expect([list.effect, version.effect, status.effect]).toEqual([
    "read-only",
    "read-only",
    "read-only",
  ]);
  expect(snapshot.effect).toBe("may-mutate");
});

it("rejects a failed read-only command without claiming an unknown outcome", async () => {
  tabsQueryError = new Error("tab query failed");

  const failure = await dispatchBrowserCommand({
    id: "list-failure",
    domain: "tab",
    session,
    call: { op: "list" },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ name: "BrowserRejected" });
  expect(failure).toMatchObject({ code: "browser-operation" });
  expect((failure as Error).message).toContain("tab.list failed");
});

it("marks a partial mutating failure as outcome unknown", async () => {
  tabsUpdateError = new Error("tab activation failed after window focus");

  const failure = await dispatchBrowserCommand({
    id: "activate-partial-failure",
    domain: "tab",
    session,
    call: { op: "activate", target: { by: "id", value: userTab.id } },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ name: "BrowserOutcomeUnknown" });
  expect((failure as Error).message).toContain("may have changed Chrome");
});

it.each([
  {
    by: "title" as const,
    value: "Duplicate",
    first: { url: "https://one.test/", title: "Duplicate one" },
    second: { url: "https://two.test/", title: "Duplicate two" },
  },
  {
    by: "url" as const,
    value: "duplicate.test",
    first: { url: "https://duplicate.test/one", title: "One" },
    second: { url: "https://duplicate.test/two", title: "Two" },
  },
])("fails closed when an explicit $by selector matches multiple tabs", async (fixture) => {
  tabs.set(2, {
    id: 2,
    windowId: userWindow.id,
    active: false,
    groupId: -1,
    ...fixture.first,
  });
  tabs.set(3, {
    id: 3,
    windowId: userWindow.id,
    active: false,
    groupId: -1,
    ...fixture.second,
  });

  await expect(
    dispatchBrowserCommand({
      id: `ambiguous-${fixture.by}`,
      domain: "tab",
      session,
      call: { op: "activate", target: { by: fixture.by, value: fixture.value } },
    }),
  ).rejects.toThrow(
    `Chrome tab ${fixture.by === "url" ? "URL" : "title"} target is ambiguous (2, 3)`,
  );

  expect(Object.keys(localStorage)).toHaveLength(0);
  expect(userTab.active).toBe(true);
});

it("keeps implicit page work inside the session-owned target", async () => {
  const result = (await dispatchBrowserCommand(navigate)) as TabResult;

  expect(userTab.url).toBe("https://user.test/");
  expect(result.id).not.toBe(userTab.id);
  expect(result.windowId).toBe(userWindow.id);
  expect(result.group?.title).toBe(session.groupTitle);
  expect(windowCreateCalls).toBe(0);

  const status = (await dispatchBrowserCommand({
    id: "status",
    domain: "system",
    session,
    call: { op: "automation-status" },
  })) as Record<string, unknown>;
  expect(status).toMatchObject({
    targets: [{ state: "owned", tab: { id: result.id } }],
  });

  const cleanup = (await dispatchBrowserCommand({
    id: "cleanup",
    domain: "system",
    session,
    call: { op: "cleanup" },
  })) as Record<string, unknown>;
  expect(cleanup).toEqual({ closedTabIds: [result.id], staleOwnershipsCleared: 0 });
  expect(tabs.has(result.id)).toBe(false);
  expect(tabs.has(userTab.id)).toBe(true);
  expect(windows.has(userWindow.id)).toBe(true);
});

it("does not group or claim an explicitly targeted user tab", async () => {
  const result = (await dispatchBrowserCommand({
    ...navigate,
    id: "navigate-explicit-user-tab",
    call: {
      target: { by: "id", value: userTab.id },
      operation: navigate.call.operation,
    },
  })) as TabResult;

  expect(result.id).toBe(userTab.id);
  expect(userTab.groupId).toBe(-1);
  expect(groups.size).toBe(0);
  expect(localStorage.piChromeAutomationTargets).toBeUndefined();
});

it("keeps explicitly targeted extension pages behind the protected URL boundary", async () => {
  tabs.set(2, {
    id: 2,
    windowId: userWindow.id,
    url: targetBootstrapUrl("11111111-1111-4111-8111-111111111111"),
    title: "Preparing Pi Chrome",
    active: false,
    groupId: -1,
  });

  await expect(
    dispatchBrowserCommand({
      ...navigate,
      id: "navigate-explicit-extension-page",
      call: {
        target: { by: "id", value: 2 },
        operation: navigate.call.operation,
      },
    }),
  ).rejects.toMatchObject({ code: "protected-tab-url" });
});

it("creates one owned tab and serializes concurrent navigation in one session", async () => {
  const results = await Promise.allSettled([
    dispatchBrowserCommand(navigate),
    dispatchBrowserCommand({ ...navigate, id: "navigate-concurrently" }),
  ]);
  const successes = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value as TabResult] : [],
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as Error] : [],
  );

  expect(successes).toHaveLength(2);
  expect(failures).toHaveLength(0);
  expect([...tabs.values()].filter((tab) => tab.id !== userTab.id)).toHaveLength(1);
  expect(Object.keys(localStorage)).toHaveLength(1);
});

it("retains allocating ownership when final persistence and created-tab closure both fail", async () => {
  localSetErrorOnCall = 2;
  tabsRemoveError = new Error("tab close failed");

  await expect(dispatchBrowserCommand(navigate)).rejects.toThrow(
    "allocation ownership was retained",
  );

  const target = storedTarget();
  expect(target).toMatchObject({ state: "allocating" });
  const created = [...tabs.values()].filter((tab) => tab.id !== userTab.id);
  expect(created).toHaveLength(1);
  expect(created[0]?.url).toBe(targetBootstrapUrl(String(target?.nonce)));

  tabsRemoveError = undefined;
  localSetErrorOnCall = undefined;
  await expect(
    dispatchBrowserCommand({
      id: "cleanup-retained-allocation",
      domain: "system",
      session,
      call: { op: "cleanup-all" },
    }),
  ).resolves.toMatchObject({ closedTabIds: [created[0]?.id] });
  expect(storedTarget()).toBeUndefined();
  expect([...tabs.keys()]).toEqual([userTab.id]);
});

it("retries allocation cleanup when the created tab closed but record clearing failed", async () => {
  localSetErrorOnCall = 2;
  localRemoveError = new Error("local remove failed");

  await expect(dispatchBrowserCommand(navigate)).rejects.toThrow(
    "allocation ownership cleanup must be retried",
  );
  expect(storedTarget()).toMatchObject({ state: "allocating" });
  expect([...tabs.keys()]).toEqual([userTab.id]);

  localSetErrorOnCall = undefined;
  localRemoveError = undefined;
  const recovered = (await dispatchBrowserCommand({
    ...navigate,
    id: "navigate-after-allocation-cleanup-failure",
  })) as TabResult;

  expect(recovered.id).not.toBe(userTab.id);
  expect(storedTarget()).toMatchObject({ state: "owned", tabId: recovered.id });
  expect([...tabs.values()].filter((tab) => tab.id !== userTab.id)).toHaveLength(1);
});

it("serializes the shared ownership map across concurrent Pi sessions", async () => {
  const otherSession = {
    key: "session:other",
    groupTitle: "Pi Session: other",
    foreground: false,
  } as const;
  const results = (await Promise.all([
    dispatchBrowserCommand(navigate),
    dispatchBrowserCommand({ ...navigate, id: "navigate-other", session: otherSession }),
  ])) as Array<TabResult>;
  const first = required(results[0], "first session did not return");
  const second = required(results[1], "second session did not return");
  const targetMap = localStorage.piChromeAutomationTargets as Record<
    string,
    ReadonlyArray<Record<string, unknown>>
  >;

  expect(first.id).not.toBe(second.id);
  expect(Object.keys(targetMap).sort()).toEqual([otherSession.key, session.key].sort());
  expect(targetMap[session.key]).toMatchObject([{ tabId: first.id }]);
  expect(targetMap[otherSession.key]).toMatchObject([{ tabId: second.id }]);
});

it("rejects a new session before tab creation when durable ownership reaches capacity", async () => {
  localStorage.piChromeAutomationTargets = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [
      `session:capacity:${index}`,
      [
        {
          state: "allocating",
          epoch: sessionStorage.piChromeBrowserEpoch,
          nonce: `capacity-${index}`,
          label: `Capacity ${index}`,
        },
      ],
    ]),
  );

  await expect(
    dispatchBrowserCommand({
      ...navigate,
      id: "navigate-over-target-capacity",
      session: {
        key: "session:capacity:overflow",
        groupTitle: "Capacity overflow",
        foreground: false,
      },
    }),
  ).rejects.toThrow("maximum is 256");

  expect(Object.keys(localStorage.piChromeAutomationTargets as object)).toHaveLength(256);
  expect([...tabs.keys()]).toEqual([userTab.id]);
});

it("cleans every provably owned session target without closing stale or unknown tabs", async () => {
  const otherSession = {
    key: "session:cleanup-all-other",
    groupTitle: "Pi Session: cleanup all other",
    foreground: false,
  } as const;
  const first = (await dispatchBrowserCommand(navigate)) as TabResult;
  const second = (await dispatchBrowserCommand({
    ...navigate,
    id: "navigate-cleanup-all-other",
    session: otherSession,
  })) as TabResult;
  const targets = localStorage.piChromeAutomationTargets as Record<
    string,
    Array<Record<string, unknown>>
  >;
  targets["session:stale-profile"] = [
    {
      state: "owned",
      epoch: "previous-browser-epoch",
      tabId: userTab.id,
      label: "Stale profile target",
    },
  ];

  const cleanup = await dispatchBrowserCommand({
    id: "cleanup-all-profile-targets",
    domain: "system",
    session,
    call: { op: "cleanup-all" },
  });

  expect(cleanup).toEqual({
    closedTabIds: [first.id, second.id],
    clearedSessionCount: 3,
    staleOwnershipsCleared: 1,
  });
  expect([...tabs.keys()]).toEqual([userTab.id]);
  expect(localStorage.piChromeAutomationTargets).toBeUndefined();

  expect(
    await dispatchBrowserCommand({
      id: "cleanup-all-profile-targets-again",
      domain: "system",
      session,
      call: { op: "cleanup-all" },
    }),
  ).toEqual({ closedTabIds: [], clearedSessionCount: 0, staleOwnershipsCleared: 0 });
});

it("refuses cleanup-all when an allocation nonce does not identify exactly one tab", async () => {
  const nonce = "22222222-2222-4222-8222-222222222222";
  localStorage.piChromeAutomationTargets = {
    [session.key]: [
      {
        state: "allocating",
        epoch: sessionStorage.piChromeBrowserEpoch,
        nonce,
        label: session.groupTitle,
      },
    ],
  };
  const url = targetBootstrapUrl(nonce);
  for (const id of [8, 9]) {
    tabs.set(id, {
      id,
      windowId: userWindow.id,
      url,
      title: "",
      active: false,
      groupId: -1,
    });
  }

  await expect(
    dispatchBrowserCommand({
      id: "cleanup-all-ambiguous-allocation",
      domain: "system",
      session,
      call: { op: "cleanup-all" },
    }),
  ).rejects.toThrow("multiple tabs carrying allocation nonce");

  expect([...tabs.keys()].sort((left, right) => left - right)).toEqual([1, 8, 9]);
  expect(storedTarget()).toMatchObject({ state: "allocating", nonce });
});

it("creates several owned tabs and requires an exact target when ownership is ambiguous", async () => {
  const command: WireCommand = {
    id: "new-owned-tab",
    domain: "tab",
    session,
    call: { op: "new", url: "https://new.test/" },
  };
  const created = (await dispatchBrowserCommand(command)) as TabResult & { readonly url?: string };

  expect(created.id).not.toBe(userTab.id);
  expect(created.url).toBe("https://new.test/");
  expect(tabs.get(created.id)?.url).toBe("https://new.test/");
  expect(navigationUrls).toEqual(["https://new.test/"]);
  expect(tabUpdates.filter(({ tabId }) => tabId === created.id)).toEqual([
    {
      tabId: created.id,
      update: { active: true },
      urlBefore: "https://new.test/",
    },
  ]);
  expect(storedTarget()).toMatchObject({
    state: "owned",
    epoch: sessionStorage.piChromeBrowserEpoch,
    tabId: created.id,
  });

  const second = (await dispatchBrowserCommand({
    id: "second-new-owned-tab",
    domain: "tab",
    session,
    call: { op: "new", url: "https://second.test/" },
  })) as TabResult;
  expect(second.id).not.toBe(created.id);
  expect(storedTargets()).toMatchObject([
    { state: "owned", tabId: created.id },
    { state: "owned", tabId: second.id },
  ]);

  const ambiguous = await dispatchBrowserCommand({
    ...navigate,
    id: "ambiguous-owned-navigation",
  }).catch((error: unknown) => error);
  expect(ambiguous).toMatchObject({
    name: "BrowserRejected",
    code: "ambiguous-owned-target",
    details: {
      ownedTargets: [
        { state: "owned", tabId: created.id },
        { state: "owned", tabId: second.id },
      ],
    },
  });

  const exact = (await dispatchBrowserCommand({
    ...navigate,
    id: "exact-owned-navigation",
    call: {
      target: { by: "id", value: created.id },
      operation: navigate.call.operation,
    },
  })) as TabResult;
  expect(exact.id).toBe(created.id);

  await dispatchBrowserCommand({
    id: "close-second-owned-tab",
    domain: "tab",
    session,
    call: { op: "close", target: { by: "id", value: second.id } },
  });
  expect(storedTargets()).toMatchObject([{ state: "owned", tabId: created.id }]);
  expect(((await dispatchBrowserCommand(navigate)) as TabResult).id).toBe(created.id);
});

it("enforces the protocol-owned per-session quota before creating a sixth tab", async () => {
  const created: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const tab = (await dispatchBrowserCommand({
      id: `new-owned-tab-${index}`,
      domain: "tab",
      session,
      call: { op: "new", url: `https://source-${index}.test/` },
    })) as TabResult;
    created.push(tab.id);
  }

  const rejected = await dispatchBrowserCommand({
    id: "new-owned-tab-over-limit",
    domain: "tab",
    session,
    call: { op: "new", url: "https://overflow.test/" },
  }).catch((error: unknown) => error);

  expect(rejected).toMatchObject({
    name: "BrowserRejected",
    code: "automation-target-limit",
    details: { scope: "session", limit: 5, current: 5 },
  });
  expect(storedTargets()).toHaveLength(5);
  expect([...tabs.keys()].filter((tabId) => tabId !== userTab.id)).toEqual(created);
});

it("cleans every target owned by one session without touching user tabs", async () => {
  const first = (await dispatchBrowserCommand({
    id: "cleanup-session-first",
    domain: "tab",
    session,
    call: { op: "new", url: "https://first.test/" },
  })) as TabResult;
  const second = (await dispatchBrowserCommand({
    id: "cleanup-session-second",
    domain: "tab",
    session,
    call: { op: "new", url: "https://second.test/" },
  })) as TabResult;

  expect(
    await dispatchBrowserCommand({
      id: "cleanup-session-targets",
      domain: "system",
      session,
      call: { op: "cleanup" },
    }),
  ).toEqual({ closedTabIds: [first.id, second.id], staleOwnershipsCleared: 0 });
  expect(localStorage.piChromeAutomationTargets).toBeUndefined();
  expect([...tabs.keys()]).toEqual([userTab.id]);
});

it("recovers an allocating tab by its unique URL within the same browser epoch", async () => {
  const nonce = "11111111-1111-4111-8111-111111111111";
  localStorage.piChromeAutomationTargets = {
    [session.key]: [
      {
        state: "allocating",
        epoch: sessionStorage.piChromeBrowserEpoch,
        nonce,
        label: session.groupTitle,
      },
    ],
  };
  userTab.groupId = 7;
  groups.set(7, {
    id: 7,
    title: "User sibling group",
    color: "red",
    collapsed: true,
    windowId: userWindow.id,
  });
  tabs.set(9, {
    id: 9,
    windowId: userWindow.id,
    url: targetBootstrapUrl(nonce),
    title: "",
    active: false,
    groupId: 7,
  });

  const recovered = (await dispatchBrowserCommand(navigate)) as TabResult;

  expect(recovered.id).toBe(9);
  expect(recovered.groupId).not.toBe(7);
  expect(userTab.groupId).toBe(7);
  expect(groups.get(7)).toMatchObject({
    title: "User sibling group",
    color: "red",
    collapsed: true,
  });
  expect([...tabs.values()].filter((tab) => tab.id !== userTab.id)).toHaveLength(1);
  expect(storedTarget()).toMatchObject({
    state: "owned",
    epoch: sessionStorage.piChromeBrowserEpoch,
    tabId: 9,
  });
  expect(storedTarget()).not.toHaveProperty("nonce");
});

it("does not read or migrate the pre-map ownership storage key", async () => {
  const legacyKey = `piChromeAutomationTarget:${session.key}`;
  const legacy = {
    state: "owned",
    epoch: sessionStorage.piChromeBrowserEpoch,
    tabId: userTab.id,
    label: session.groupTitle,
  };
  localStorage[legacyKey] = legacy;

  const result = (await dispatchBrowserCommand(navigate)) as TabResult;

  expect(result.id).not.toBe(userTab.id);
  expect(localStorage[legacyKey]).toBe(legacy);
  expect(storedTarget()).toMatchObject({ state: "owned", tabId: result.id });
});

it("bounds the persisted target label at the ownership boundary", async () => {
  const longSession = {
    ...session,
    key: "session:long-label",
    groupTitle: `Pi Session: ${"x".repeat(200)}`,
  };

  await dispatchBrowserCommand({ ...navigate, id: "long-label", session: longSession });

  const targetMap = localStorage.piChromeAutomationTargets as Record<
    string,
    ReadonlyArray<Record<string, unknown>>
  >;
  expect(targetMap[longSession.key]?.[0]?.label).toHaveLength(80);
});

it("projects a renamed Pi session onto its existing Chrome group", async () => {
  const first = (await dispatchBrowserCommand(navigate)) as TabResult;
  const renamed = { ...session, groupTitle: "Pi · 修复浏览器标题" };

  const second = (await dispatchBrowserCommand({
    ...navigate,
    id: "navigate-after-rename",
    session: renamed,
  })) as TabResult;

  expect(second.id).toBe(first.id);
  expect(groups.get(second.groupId ?? -1)?.title).toBe(renamed.groupTitle);
});

it("never adopts a user tab when an owned tab shares its visual group", async () => {
  const groupedTab: MockTab = {
    id: 2,
    windowId: userWindow.id,
    url: "https://prior.test/",
    title: "Prior",
    active: false,
    groupId: 7,
  };
  tabs.set(groupedTab.id, groupedTab);
  groups.set(7, {
    id: 7,
    title: session.groupTitle,
    color: "blue",
    collapsed: false,
    windowId: userWindow.id,
  });

  const result = (await dispatchBrowserCommand(navigate)) as TabResult;

  expect(result.id).not.toBe(groupedTab.id);
  expect(result.groupId).not.toBe(7);
  expect(groupedTab.groupId).toBe(7);
  expect(groups.get(7)?.title).toBe(session.groupTitle);
  expect(storedTarget()).toMatchObject({
    state: "owned",
    epoch: sessionStorage.piChromeBrowserEpoch,
    tabId: result.id,
  });
  expect(userTab.url).toBe("https://user.test/");
  expect(windowCreateCalls).toBe(0);
});

it("moves only the explicitly selected tab into a fresh Pi group", async () => {
  const sibling: MockTab = {
    id: 2,
    windowId: userWindow.id,
    url: "https://sibling.test/",
    title: "Sibling",
    active: false,
    groupId: 7,
  };
  userTab.groupId = 7;
  tabs.set(sibling.id, sibling);
  groups.set(7, {
    id: 7,
    title: "User group",
    color: "red",
    collapsed: true,
    windowId: userWindow.id,
  });

  const grouped = (await dispatchBrowserCommand({
    id: "group-explicit-tab",
    domain: "tab",
    session,
    call: { op: "group", target: { by: "id", value: userTab.id }, groupColor: "blue" },
  })) as TabResult;

  expect(grouped.id).toBe(userTab.id);
  expect(grouped.groupId).not.toBe(7);
  expect(sibling.groupId).toBe(7);
  expect(groups.get(7)).toMatchObject({ title: "User group", color: "red", collapsed: true });
});

it("fails closed when the exact tab id is stale and its removal was not observed", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;
  groups.get(initial.groupId)!.title = "Display label changed";
  tabs.delete(initial.id);

  await expect(dispatchBrowserCommand(navigate)).rejects.toThrow("lost its exact automation tab");

  const status = (await dispatchBrowserCommand({
    id: "status-stale-tab",
    domain: "system",
    session,
    call: { op: "automation-status" },
  })) as Record<string, unknown>;

  expect(status).toMatchObject({
    targets: [{ state: "stale", reason: "tab-missing", recordedTabId: initial.id }],
  });
  expect([...tabs.keys()]).toEqual([userTab.id]);
  expect(Object.keys(localStorage)).toHaveLength(1);
});

it("explicit cleanup clears stale ownership without closing another tab", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;
  tabs.delete(initial.id);

  const cleanup = await dispatchBrowserCommand({
    id: "cleanup-stale-ownership",
    domain: "system",
    session,
    call: { op: "cleanup" },
  });

  expect(cleanup).toEqual({ closedTabIds: [], staleOwnershipsCleared: 1 });
  expect(Object.keys(localStorage)).toHaveLength(0);
  expect([...tabs.keys()]).toEqual([userTab.id]);
});

it("clears ownership only for an exact observed tab removal", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;
  localStorage.piChromeCommandJournal = { result: "x".repeat(100_000) };
  localGetKeys.length = 0;
  await handleAutomationTabRemoved(userTab.id, {
    isWindowClosing: false,
    windowId: userWindow.id,
  });
  expect(localGetKeys).toEqual(["piChromeAutomationTargets"]);
  delete localStorage.piChromeCommandJournal;
  expect(Object.keys(localStorage)).toHaveLength(1);

  await chromeMock.tabs.group({ groupId: initial.groupId, tabIds: [userTab.id] });
  expect(userTab.groupId).toBe(initial.groupId);

  await chromeMock.tabs.remove(initial.id);
  await handleAutomationTabRemoved(initial.id, {
    isWindowClosing: false,
    windowId: userWindow.id,
  });
  expect(Object.keys(localStorage)).toHaveLength(0);

  const replacement = (await dispatchBrowserCommand(navigate)) as TabResult;
  expect(replacement.id).not.toBe(initial.id);
  expect(replacement.id).not.toBe(userTab.id);
  expect(userTab.groupId).toBe(initial.groupId);
  expect(userTab.url).toBe("https://user.test/");
});

it("clears ownership when exact tab removal is observed during window closing", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;
  await chromeMock.tabs.remove(initial.id);
  await handleAutomationTabRemoved(initial.id, {
    isWindowClosing: true,
    windowId: userWindow.id,
  });
  expect(Object.keys(localStorage)).toHaveLength(0);

  const replacement = (await dispatchBrowserCommand(navigate)) as TabResult;
  expect(replacement.id).not.toBe(initial.id);
  expect(replacement.id).not.toBe(userTab.id);
});

it("fails closed when the bound profile has no regular Chrome window", async () => {
  windows.clear();
  tabs.clear();
  windows.set(3, { id: 3, type: "popup", focused: true, incognito: false });
  tabs.set(3, {
    id: 3,
    windowId: 3,
    url: "https://popup.test/",
    title: "Popup",
    active: true,
    groupId: -1,
  });

  await expect(dispatchBrowserCommand(navigate)).rejects.toThrow(
    "Open the bound Chrome profile and try again",
  );
  expect([...tabs.keys()]).toEqual([3]);
  expect(Object.keys(localStorage)).toHaveLength(0);
  expect(windowCreateCalls).toBe(0);
});

it("recovers the exact owned tab after MV3 worker suspension", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;

  vi.resetModules();
  const resumedWorker = await import("../../src/browser/platform.js");
  handleDebuggerEvent = resumedWorker.handleDebuggerEvent;
  const status = (await resumedWorker.dispatchBrowserCommand({
    id: "status-after-worker-suspension",
    domain: "system",
    session,
    call: { op: "automation-status" },
  })) as Record<string, unknown>;
  const resumed = (await resumedWorker.dispatchBrowserCommand(navigate)) as TabResult;

  expect(status).toMatchObject({
    targets: [{ state: "owned", tab: { id: initial.id } }],
  });
  expect(resumed.id).toBe(initial.id);
  expect([...tabs.values()].filter((tab) => tab.id !== userTab.id)).toHaveLength(1);
});

it("fails closed across extension reload or browser restart until explicit cleanup", async () => {
  const initial = (await dispatchBrowserCommand(navigate)) as TabResult;
  const storageKeys = Object.keys(localStorage);
  expect(storageKeys).toEqual(["piChromeAutomationTargets"]);
  expect(storedTarget()).toMatchObject({ state: "owned", tabId: initial.id });

  for (const key of Object.keys(sessionStorage)) delete sessionStorage[key];
  vi.resetModules();
  const restarted = await import("../../src/browser/platform.js");
  handleDebuggerEvent = restarted.handleDebuggerEvent;
  const status = (await restarted.dispatchBrowserCommand({
    id: "status-after-restart",
    domain: "system",
    session,
    call: { op: "automation-status" },
  })) as Record<string, unknown>;
  expect(status).toMatchObject({
    targets: [{ state: "stale", reason: "epoch-changed", recordedTabId: initial.id }],
  });
  await expect(restarted.dispatchBrowserCommand(navigate)).rejects.toThrow(
    "previous browser epoch",
  );
  expect(tabs.has(initial.id)).toBe(true);

  const cleanup = await restarted.dispatchBrowserCommand({
    id: "cleanup-after-restart",
    domain: "system",
    session,
    call: { op: "cleanup" },
  });
  expect(cleanup).toEqual({ closedTabIds: [], staleOwnershipsCleared: 1 });
  expect(tabs.has(initial.id)).toBe(true);

  const replacement = (await restarted.dispatchBrowserCommand(navigate)) as TabResult;
  expect(replacement.id).not.toBe(initial.id);
  expect(replacement.id).not.toBe(userTab.id);
  expect(tabs.has(initial.id)).toBe(true);
});
