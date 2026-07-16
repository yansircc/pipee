import { runInNewContext } from "node:vm";
import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const exactTab = resolvedTabFixture();

const cdpMocks = vi.hoisted(() => ({
  cdpEval: vi.fn(),
  executeScript: vi.fn(),
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: vi.fn(),
  cdp: vi.fn(),
  cdpEval: cdpMocks.cdpEval,
  cdpExceptionText: vi.fn(() => ""),
  executeScript: cdpMocks.executeScript,
  sleep: vi.fn(),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: vi.fn(),
  formatTab: vi.fn(),
  getTabByParams: vi.fn(async () => ({ id: 7, windowId: 1, active: true })),
}));

let executeInTab: typeof import("../../src/browser/platform-page.js").executeInTab;
let hostileAction: ReturnType<typeof vi.fn>;
let sandbox: { window: { __piAction: ReturnType<typeof vi.fn> } };

beforeAll(async () => {
  ({ executeInTab } = await import("../../src/browser/platform-page.js"));
});

beforeEach(() => {
  hostileAction = vi.fn(() => "hostile");
  sandbox = { window: { __piAction: hostileAction } };
  cdpMocks.executeScript.mockClear();
  cdpMocks.cdpEval.mockReset();
  cdpMocks.cdpEval.mockImplementation(async (_tabId: number, expression: string) => ({
    result: {
      type: "object",
      value: await runInNewContext(expression, sandbox),
    },
  }));
});

it("executes helpers and action atomically without consulting window.__piAction", async () => {
  const result = await executeInTab(
    {
      foreground: false,
      tab: exactTab,
    },
    () => "trusted",
    [],
  );

  expect(result).toBe("trusted");
  expect(hostileAction).not.toHaveBeenCalled();
  expect(sandbox.window.__piAction).toBe(hostileAction);
  expect(cdpMocks.executeScript).not.toHaveBeenCalled();
  expect(cdpMocks.cdpEval.mock.calls[0]?.[1]).not.toContain("__piAction");
});
