import { runInNewContext } from "node:vm";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { projectEvaluationValue } from "../../src/browser/injected/evaluation-value.js";
import { EVALUATION_VALUE_CONTRACT } from "../../src/protocol/evaluation-value-contract.js";
import type { WireCommand } from "../../src/protocol/schema.js";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const targetMocks = vi.hoisted(() => ({
  getTabByParams: vi.fn(),
}));

const pageMocks = vi.hoisted(() => ({
  evaluateInTab: vi.fn(),
  snapshotInTab: vi.fn(),
  snapshotTabs: [] as Array<number>,
  withPostActionVerification: vi.fn(),
}));

const inputMocks = vi.hoisted(() => ({
  click: vi.fn(),
}));

const cdpMocks = vi.hoisted(() => ({
  navigateTab: vi.fn(),
  sleep: vi.fn(),
}));

const targetFormatMocks = vi.hoisted(() => ({
  formatTab: vi.fn(),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: vi.fn(),
  cleanupAllAutomationTargets: vi.fn(),
  cleanupAutomationTarget: vi.fn(),
  createNewAutomationTarget: vi.fn(),
  formatTab: targetFormatMocks.formatTab,
  getAutomationTargetStatus: vi.fn(),
  getTabByParams: targetMocks.getTabByParams,
  groupTab: vi.fn(),
  releaseAutomationTargetTab: vi.fn(),
}));

vi.mock("../../src/browser/platform-page.js", () => ({
  evaluateInTab: pageMocks.evaluateInTab,
  executeInTab: vi.fn(),
  inspectInTab: vi.fn(),
  navigationInitScriptSource: vi.fn(() => "init-script-source"),
  snapshotInTab: pageMocks.snapshotInTab,
  takeScreenshot: vi.fn(),
  withPostActionVerification: pageMocks.withPostActionVerification,
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  detachAllDebuggers: vi.fn(),
  detachExpiredDebuggers: vi.fn(),
  handleDebuggerDetach: vi.fn(),
  handleDebuggerEvent: vi.fn(),
  inputStatus: vi.fn(),
  navigateTab: cdpMocks.navigateTab,
  sleep: cdpMocks.sleep,
}));

vi.mock("../../src/browser/platform-input-click.js", () => ({
  chromeInputClick: inputMocks.click,
  chromeInputHover: vi.fn(),
}));

vi.mock("../../src/browser/platform-input-pointer.js", () => ({
  chromeInputDrag: vi.fn(),
  chromeInputScroll: vi.fn(),
  chromeInputTap: vi.fn(),
  chromeInputUpload: vi.fn(),
}));

vi.mock("../../src/browser/platform-input-text.js", () => ({
  chromeInputFill: vi.fn(),
  chromeInputKey: vi.fn(),
  chromeInputType: vi.fn(),
}));

let dispatchBrowserCommand: typeof import("../../src/browser/platform.js").dispatchBrowserCommand;
let now = 0;
let dateNow: ReturnType<typeof vi.spyOn>;
let sandbox: Record<string, unknown>;

beforeAll(async () => {
  ({ dispatchBrowserCommand } = await import("../../src/browser/platform.js"));
});

beforeEach(() => {
  now = 0;
  dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
  targetMocks.getTabByParams.mockReset();
  targetMocks.getTabByParams
    .mockResolvedValueOnce(resolvedTabFixture(7, 1))
    .mockResolvedValue(resolvedTabFixture(8, 2));
  pageMocks.evaluateInTab.mockReset();
  sandbox = {
    document: {
      body: { innerText: "Ready body" },
      title: "Ready page",
      readyState: "complete",
      querySelectorAll: (selector: string) => (selector === "#ready" ? [{}] : []),
    },
    location: { href: "https://stable.test/ready" },
  };
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async (tabId: number) => resolvedTabFixture(tabId, 1)),
    },
  });
  pageMocks.evaluateInTab.mockImplementation(
    async (params: { readonly expression: string; readonly evaluationTimeoutMs?: number }) => {
      if (params.expression.includes("new Promise")) {
        throw new Error(`Runtime.evaluate timed out after ${params.evaluationTimeoutMs}ms`);
      }
      const value = await runInNewContext(params.expression, sandbox);
      return projectEvaluationValue(JSON.parse(JSON.stringify(value)), EVALUATION_VALUE_CONTRACT);
    },
  );
  pageMocks.snapshotTabs.length = 0;
  pageMocks.snapshotInTab.mockReset();
  pageMocks.snapshotInTab.mockResolvedValue({ mode: "text", contentBlocks: [] });
  cdpMocks.navigateTab.mockReset();
  targetFormatMocks.formatTab.mockReset();
  targetFormatMocks.formatTab.mockImplementation(async (tab: unknown) => tab);
  pageMocks.withPostActionVerification.mockReset();
  pageMocks.withPostActionVerification.mockImplementation(
    async (
      params: { readonly tab: { readonly id: number }; readonly includeSnapshot?: boolean },
      action: (input: unknown) => unknown,
    ) => {
      const result = await action(params);
      if (params.includeSnapshot) pageMocks.snapshotTabs.push(params.tab.id);
      return {
        action: result,
        verification: params.includeSnapshot
          ? { status: "observed", snapshot: "snapshot" }
          : { status: "not-requested" },
      };
    },
  );
  inputMocks.click.mockReset();
  inputMocks.click.mockResolvedValue({ clicked: true });
  cdpMocks.sleep.mockReset();
  cdpMocks.sleep.mockImplementation(async (milliseconds: number) => {
    now += milliseconds;
  });
});

afterEach(() => {
  dateNow.mockRestore();
  vi.unstubAllGlobals();
});

const session = {
  key: "session:exact-tab",
  groupTitle: "Exact tab",
  foreground: false,
} as const;

const waitCommand = (expression: string): WireCommand => ({
  id: `wait:${expression}`,
  domain: "page",
  session,
  call: {
    target: { by: "url", value: "stable.test" },
    operation: {
      kind: "wait",
      condition: { by: "expression", value: expression },
      timeoutMs: 2,
      intervalMs: 1,
    },
  },
});

it("uses one exact tab for an input action and its optional snapshot", async () => {
  const command: WireCommand = {
    id: "click-with-snapshot",
    domain: "input",
    session,
    call: {
      target: { by: "url", value: "stable.test" },
      operation: {
        kind: "click",
        at: { by: "coordinate", x: 10, y: 20 },
        includeSnapshot: true,
      },
    },
  };

  await expect(dispatchBrowserCommand(command)).resolves.toEqual({
    action: { clicked: true },
    verification: { status: "observed", snapshot: "snapshot" },
  });
  expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
  expect(inputMocks.click).toHaveBeenCalledWith(
    expect.objectContaining({ tab: expect.objectContaining({ id: 7 }) }),
  );
  expect(pageMocks.snapshotTabs).toEqual([7]);
});

it.each(["undefined", "NaN", "-0"])(
  "preserves JavaScript falsiness for %s after JSON projection",
  async (expression) => {
    await expect(dispatchBrowserCommand(waitCommand(expression))).resolves.toEqual({
      satisfied: false,
      elapsedMs: 2,
      observation: {
        url: "https://stable.test/ready",
        title: "Ready page",
        readyState: "complete",
        bodyTextLength: 10,
      },
    });
    expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
    expect(pageMocks.evaluateInTab).toHaveBeenCalledTimes(2);
    expect(pageMocks.evaluateInTab.mock.calls.every(([params]) => params.tab.id === 7)).toBe(true);
  },
);

it.each(['"ready"', 'Promise.resolve("ready")'])(
  "preserves JavaScript truthiness for %s after JSON projection",
  async (expression) => {
    await expect(dispatchBrowserCommand(waitCommand(expression))).resolves.toEqual({
      satisfied: true,
      elapsedMs: 0,
      observation: {
        url: "https://stable.test/ready",
        title: "Ready page",
        readyState: "complete",
        bodyTextLength: 10,
      },
    });
    expect(pageMocks.evaluateInTab).toHaveBeenCalledTimes(1);
    expect(pageMocks.evaluateInTab.mock.calls[0]?.[0]).toMatchObject({
      tab: { id: 7 },
      awaitPromise: true,
      evaluationTimeoutMs: 2,
    });
  },
);

it.each([
  ["selector" as const, "#ready", 1],
  ["urlIncludes" as const, "stable.test", undefined],
  ["textContains" as const, "Ready body", undefined],
])("evaluates typed %s waits without caller-authored DOM logic", async (by, value, matchCount) => {
  const result = await dispatchBrowserCommand({
    id: `wait:${by}`,
    domain: "page",
    session,
    call: {
      target: { by: "url", value: "stable.test" },
      operation: {
        kind: "wait",
        condition: { by, value },
        timeoutMs: 2,
        intervalMs: 1,
      },
    },
  });

  expect(result).toMatchObject({
    satisfied: true,
    elapsedMs: 0,
    observation: {
      url: "https://stable.test/ready",
      ...(matchCount === undefined ? {} : { matchCount }),
    },
  });
  expect(pageMocks.evaluateInTab).toHaveBeenCalledTimes(1);
});

it("keeps navigation and its nested snapshot on one resolved tab", async () => {
  const result = await dispatchBrowserCommand({
    id: "navigate-with-snapshot",
    domain: "page",
    session,
    call: {
      target: { by: "url", value: "stable.test" },
      operation: {
        kind: "navigate",
        url: "https://stable.test/result",
        snapshot: { mode: "text", maxTextChars: 4_000 },
      },
    },
  });

  expect(result).toMatchObject({
    tab: { id: 7 },
    snapshot: { mode: "text", contentBlocks: [] },
  });
  expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
  expect(cdpMocks.navigateTab).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }));
  expect(cdpMocks.navigateTab).toHaveBeenCalledWith(
    expect.objectContaining({ milestone: "commit" }),
  );
  expect(pageMocks.snapshotInTab).toHaveBeenCalledWith(
    expect.objectContaining({ tab: expect.objectContaining({ id: 7 }), foreground: false }),
  );
});

it("waits for full load only when navigation explicitly requests it", async () => {
  await dispatchBrowserCommand({
    id: "navigate-until-load",
    domain: "page",
    session,
    call: {
      operation: {
        kind: "navigate",
        url: "https://stable.test/loaded",
        waitUntilLoad: true,
      },
    },
  });

  expect(cdpMocks.navigateTab).toHaveBeenCalledWith(expect.objectContaining({ milestone: "load" }));
});

it("bounds a never-settling wait promise by the remaining command deadline", async () => {
  await expect(dispatchBrowserCommand(waitCommand("new Promise(() => undefined)"))).rejects.toThrow(
    "Runtime.evaluate timed out after 2ms",
  );
  expect(pageMocks.evaluateInTab).toHaveBeenCalledTimes(1);
  expect(pageMocks.evaluateInTab.mock.calls[0]?.[0].evaluationTimeoutMs).toBe(2);
  expect(targetMocks.getTabByParams).toHaveBeenCalledTimes(1);
});
