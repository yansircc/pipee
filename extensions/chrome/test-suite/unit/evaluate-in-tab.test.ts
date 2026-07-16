import { runInNewContext } from "node:vm";
import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { COMMAND_DEADLINES_MS } from "../../src/protocol/bridge-contract.js";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const pageMocks = vi.hoisted(() => ({
  bringToFront: vi.fn(),
  cdpEval: vi.fn(),
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: vi.fn(),
  cdp: vi.fn(),
  cdpEval: pageMocks.cdpEval,
  cdpExceptionText: vi.fn(() => ""),
  executeScript: vi.fn(),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: pageMocks.bringToFront,
  formatTab: vi.fn(),
}));

let evaluateInTab: typeof import("../../src/browser/platform-page.js").evaluateInTab;
let sandbox: Record<string, unknown>;

beforeAll(async () => {
  ({ evaluateInTab } = await import("../../src/browser/platform-page.js"));
});

beforeEach(() => {
  sandbox = {};
  pageMocks.bringToFront.mockClear();
  pageMocks.cdpEval.mockReset();
  pageMocks.cdpEval.mockImplementation(
    async (_tabId: number, expression: string, options: Record<string, unknown>) => {
      const evaluated = runInNewContext(expression, sandbox);
      const value = options.awaitPromise === false ? evaluated : await evaluated;
      return {
        result: {
          type: value === null ? "object" : typeof value,
          value,
        },
      };
    },
  );
});

it("awaits the user promise only when awaitPromise is enabled", async () => {
  let resolvePending!: (value: number) => void;
  sandbox.pending = new Promise<number>((resolve) => {
    resolvePending = resolve;
  });
  const evaluation = evaluateInTab({
    tab: resolvedTabFixture(),
    foreground: false,
    expression: "pending",
    awaitPromise: true,
  });
  let settled = false;
  void evaluation.then(() => {
    settled = true;
  });

  await Promise.resolve();
  expect(settled).toBe(false);
  resolvePending(42);
  await expect(evaluation).resolves.toBe(42);
  expect(pageMocks.cdpEval.mock.calls[0]?.[2]).toEqual({
    awaitPromise: true,
    timeout: COMMAND_DEADLINES_MS.defaultExecution,
  });
});

it("projects an unresolved promise immediately when awaitPromise is disabled", async () => {
  sandbox.pending = new Promise<never>(() => undefined);

  await expect(
    evaluateInTab({
      tab: resolvedTabFixture(),
      foreground: false,
      expression: "pending",
      awaitPromise: false,
      evaluationTimeoutMs: 123,
    }),
  ).resolves.toMatchObject({
    _tag: "PiChromeEvaluationMarker",
    kind: "NonPlainObject",
    constructorName: "Promise",
    objectTag: "[object Promise]",
  });
  expect(pageMocks.cdpEval.mock.calls[0]?.[2]).toEqual({
    awaitPromise: false,
    timeout: 123,
  });
  expect(pageMocks.bringToFront).not.toHaveBeenCalled();
});

it("never retries a runtime SyntaxError through a second source form", async () => {
  pageMocks.cdpEval.mockResolvedValueOnce({
    exceptionDetails: {
      text: "Uncaught",
      exception: { className: "SyntaxError", description: "SyntaxError: runtime failure" },
    },
  });

  await expect(
    evaluateInTab({
      tab: resolvedTabFixture(),
      foreground: false,
      expression:
        "(() => { globalThis.sideEffect = 1; throw new SyntaxError('runtime failure') })()",
      awaitPromise: true,
    }),
  ).rejects.toThrow("chrome_evaluate failed");
  expect(pageMocks.cdpEval).toHaveBeenCalledTimes(1);
});
