import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { SCREENSHOT_TRANSPORT_BYTE_LIMIT } from "../../src/browser/screenshot-transport.js";
import {
  SCREENSHOT_LIMITS,
  SCREENSHOT_MAX_TILE_COUNT,
} from "../../src/protocol/bridge-contract.js";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const exactTab = resolvedTabFixture();

const pageMocks = vi.hoisted(() => {
  const capturedBase64: Array<string> = [];
  let metrics = {
    contentSize: { x: 0, y: 0, width: 800, height: 1_600 },
    visualViewport: { clientWidth: 800, clientHeight: 800 },
  };
  let dpr = 1;
  return {
    bringToFront: vi.fn(),
    capturedBase64,
    get metrics() {
      return metrics;
    },
    set metrics(value) {
      metrics = value;
    },
    get dpr() {
      return dpr;
    },
    set dpr(value) {
      dpr = value;
    },
    cdp: vi.fn(async (_tabId: number, method: string, _params?: Record<string, unknown>) =>
      method === "Page.getLayoutMetrics" ? metrics : { data: capturedBase64.shift() ?? "" },
    ),
    cdpEval: vi.fn(async () => ({
      result: { type: "number", value: dpr },
    })),
    executeScript: vi.fn(async () => [
      {
        documentId: "document",
        frameId: 0,
        result: { ok: true, value: undefined },
      },
    ]),
    getTabByParams: vi.fn(async () => ({
      id: 7,
      windowId: 1,
      active: true,
      url: "https://screenshot.test/",
    })),
  };
});

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: vi.fn(),
  cdp: pageMocks.cdp,
  cdpEval: pageMocks.cdpEval,
  cdpExceptionText: vi.fn(() => ""),
  executeScript: pageMocks.executeScript,
  sleep: vi.fn(),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: pageMocks.bringToFront,
  formatTab: vi.fn(async (tab) => tab),
  getTabByParams: pageMocks.getTabByParams,
}));

const chromeMock = {
  tabs: {
    get: vi.fn(async () => ({
      id: 7,
      windowId: 1,
      active: true,
      highlighted: true,
      title: "Screenshot",
      url: "https://screenshot.test/",
      groupId: -1,
    })),
    query: vi.fn(async () => []),
    update: vi.fn(),
  },
};

let takeScreenshot: typeof import("../../src/browser/platform-page.js").takeScreenshot;

beforeAll(async () => {
  Object.assign(globalThis, { chrome: chromeMock });
  ({ takeScreenshot } = await import("../../src/browser/platform-page.js"));
});

beforeEach(() => {
  pageMocks.capturedBase64.length = 0;
  pageMocks.metrics = {
    contentSize: { x: 0, y: 0, width: 800, height: 1_600 },
    visualViewport: { clientWidth: 800, clientHeight: 800 },
  };
  pageMocks.dpr = 1;
  pageMocks.cdp.mockClear();
  pageMocks.cdpEval.mockClear();
  pageMocks.executeScript.mockClear();
  pageMocks.bringToFront.mockClear();
  chromeMock.tabs.get.mockClear();
});

it("stops before returning an oversized full-page result from the pinned tab", async () => {
  const prefixLength = "data:image/png;base64,".length;
  pageMocks.capturedBase64.push(
    "a".repeat(SCREENSHOT_TRANSPORT_BYTE_LIMIT - prefixLength - 1),
    "bb",
  );

  await expect(
    takeScreenshot({
      foreground: true,
      capture: { kind: "full-page-tiles" },
      format: "png",
      tab: exactTab,
    }),
  ).rejects.toThrow(`limit is ${SCREENSHOT_TRANSPORT_BYTE_LIMIT} bytes`);
  expect(
    pageMocks.cdp.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
  ).toHaveLength(2);
  expect(pageMocks.cdpEval).toHaveBeenCalledTimes(1);
  expect(pageMocks.executeScript).not.toHaveBeenCalled();
  expect(pageMocks.bringToFront).not.toHaveBeenCalled();
  expect(pageMocks.cdp.mock.calls.every(([tabId]) => tabId === exactTab.id)).toBe(true);
  expect(pageMocks.cdpEval).toHaveBeenCalledWith(exactTab.id, "window.devicePixelRatio");
});

it("captures a final partial tile from the exact tab without changing focus", async () => {
  pageMocks.metrics = {
    contentSize: { x: 0, y: 0, width: 800, height: 1_601 },
    visualViewport: { clientWidth: 800, clientHeight: 800 },
  };
  pageMocks.capturedBase64.push("first", "second", "third");

  await takeScreenshot({
    foreground: true,
    capture: { kind: "full-page-tiles" },
    format: "png",
    tab: exactTab,
  });

  const captures = pageMocks.cdp.mock.calls.filter(
    ([, method]) => method === "Page.captureScreenshot",
  );
  expect(
    captures.map(([tabId, , params]) => ({
      tabId,
      clip: params?.clip,
    })),
  ).toEqual([
    { tabId: exactTab.id, clip: { x: 0, y: 0, width: 800, height: 800, scale: 1 } },
    { tabId: exactTab.id, clip: { x: 0, y: 800, width: 800, height: 800, scale: 1 } },
    { tabId: exactTab.id, clip: { x: 0, y: 1_600, width: 800, height: 1, scale: 1 } },
  ]);
  expect(pageMocks.cdp.mock.calls.every(([tabId]) => tabId === exactTab.id)).toBe(true);
  expect(pageMocks.cdpEval).toHaveBeenCalledWith(exactTab.id, "window.devicePixelRatio");
  expect(pageMocks.bringToFront).not.toHaveBeenCalled();
});

it("rejects an oversized tile plan before the first browser capture", async () => {
  pageMocks.metrics = {
    contentSize: { x: 0, y: 0, width: 800, height: SCREENSHOT_MAX_TILE_COUNT + 1 },
    visualViewport: { clientWidth: 800, clientHeight: 1 },
  };

  await expect(
    takeScreenshot({
      foreground: false,
      capture: { kind: "full-page-tiles" },
      format: "png",
      tab: exactTab,
    }),
  ).rejects.toThrow(`maximum is ${SCREENSHOT_MAX_TILE_COUNT}`);
  expect(
    pageMocks.cdp.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
  ).toHaveLength(0);
  expect(pageMocks.cdp.mock.calls.every(([tabId]) => tabId === exactTab.id)).toBe(true);
});

it.each([
  {
    name: "device pixel ratio",
    metrics: {
      contentSize: { x: 0, y: 0, width: 800, height: 800 },
      visualViewport: { clientWidth: 800, clientHeight: 800 },
    },
    dpr: SCREENSHOT_LIMITS.maxDpr + 1,
    message: "device pixel ratio",
  },
  {
    name: "capture pixels",
    metrics: {
      contentSize: { x: 0, y: 0, width: SCREENSHOT_LIMITS.maxCapturePixels + 1, height: 1 },
      visualViewport: { clientWidth: 1, clientHeight: 1 },
    },
    dpr: 1,
    message: "maximum per capture",
  },
])("rejects unsafe $name before allocating a screenshot bitmap", async (fixture) => {
  pageMocks.metrics = fixture.metrics;
  pageMocks.dpr = fixture.dpr;

  await expect(
    takeScreenshot({
      foreground: false,
      capture: { kind: "full-page-tiles" },
      format: "png",
      tab: exactTab,
    }),
  ).rejects.toThrow(fixture.message);

  expect(
    pageMocks.cdp.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
  ).toHaveLength(0);
});

it("applies the same raster preflight to viewport capture before allocation", async () => {
  pageMocks.metrics = {
    contentSize: { x: 0, y: 0, width: SCREENSHOT_LIMITS.maxCapturePixels + 1, height: 1 },
    visualViewport: {
      clientWidth: SCREENSHOT_LIMITS.maxCapturePixels + 1,
      clientHeight: 1,
    },
  };

  await expect(
    takeScreenshot({
      foreground: true,
      capture: { kind: "viewport" },
      format: "png",
      tab: exactTab,
    }),
  ).rejects.toThrow("maximum per capture");

  expect(
    pageMocks.cdp.mock.calls.filter(([, method]) => method === "Page.captureScreenshot"),
  ).toHaveLength(0);
  expect(pageMocks.bringToFront).not.toHaveBeenCalled();
});
