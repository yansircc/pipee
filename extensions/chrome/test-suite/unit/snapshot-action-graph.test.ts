import { beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

const pageMocks = vi.hoisted(() => ({
  attachDebugger: vi.fn(),
  cdp: vi.fn(),
  executeScript: vi.fn(),
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: pageMocks.attachDebugger,
  cdp: pageMocks.cdp,
  cdpEval: vi.fn(),
  cdpExceptionText: vi.fn(),
  executeScript: pageMocks.executeScript,
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: vi.fn(),
  formatTab: vi.fn(),
}));

let snapshotInTab: typeof import("../../src/browser/platform-page.js").snapshotInTab;
let readInTab: typeof import("../../src/browser/platform-page.js").readInTab;

beforeAll(async () => {
  ({ snapshotInTab, readInTab } = await import("../../src/browser/platform-page.js"));
});

it("joins the full graph before budgeting and emits an expandable context frontier", async () => {
  pageMocks.executeScript.mockReset();
  pageMocks.executeScript
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        result: {
          ok: true,
          value: {
            title: "Dense checkout",
            url: "https://shop.example.test/dense",
            mode: "interactive",
            actions: [
              {
                kind: "action",
                id: "el-1",
                role: "button",
                name: "One",
                state: {},
                verbs: ["click"],
              },
              {
                kind: "action",
                id: "el-2",
                role: "button",
                name: "Two",
                state: {},
                verbs: ["click"],
              },
              {
                kind: "action",
                id: "el-3",
                role: "button",
                name: "Three",
                state: {},
                verbs: ["click"],
              },
            ],
            contexts: [],
            frontiers: [],
            actionContextById: {
              "el-1": {
                uid: "el-9",
                role: "form",
                label: "Checkout",
                tag: "form",
                rect: { x: 0, y: 0, width: 100, height: 100 },
              },
              "el-2": {
                uid: "el-9",
                role: "form",
                label: "Checkout",
                tag: "form",
                rect: { x: 0, y: 0, width: 100, height: 100 },
              },
              "el-3": {
                uid: "el-9",
                role: "form",
                label: "Checkout",
                tag: "form",
                rect: { x: 0, y: 0, width: 100, height: 100 },
              },
            },
          },
        },
      },
    ])
    .mockResolvedValueOnce([{ result: [{ id: "frontier-1", name: "Checkout", omittedCount: 2 }] }]);
  pageMocks.cdp.mockImplementation((_tabId: number, method: string) => {
    if (method === "DOM.enable" || method === "Runtime.releaseObject") return Promise.resolve({});
    if (method === "Accessibility.getFullAXTree") return Promise.resolve({ nodes: [] });
    return Promise.reject(new Error(`Unexpected CDP method ${method}`));
  });

  const snapshot = await snapshotInTab({
    tab: resolvedTabFixture(),
    foreground: false,
    mode: "interactive",
    maxElements: 1,
  });

  expect(snapshot.actions.map(({ id }) => id)).toEqual(["el-1"]);
  expect(snapshot.contexts).toEqual([
    {
      kind: "context",
      id: "el-9",
      role: "form",
      name: "Checkout",
      actionCount: 3,
      shownActionCount: 1,
    },
  ]);
  expect(snapshot.frontiers).toEqual([
    {
      kind: "frontier",
      id: "frontier-1",
      projection: "actions",
      name: "Checkout",
      omittedCount: 2,
    },
  ]);
});

it("reads rendered content without invoking AX action discovery", async () => {
  pageMocks.executeScript.mockReset();
  pageMocks.executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([
    {
      result: {
        ok: true,
        value: {
          title: "Account",
          url: "https://app.example.test/account",
          view: "content",
          blocks: [{ kind: "paragraph", uid: "el-1", text: "Signed-in content", links: [] }],
          frontiers: [],
          coverage: {
            returnedBlocks: 1,
            totalBlocks: 1,
            returnedCharacters: 17,
            truncated: false,
          },
        },
      },
    },
  ]);
  pageMocks.cdp.mockClear();

  await expect(
    readInTab({ tab: resolvedTabFixture(), foreground: false, view: "content" }),
  ).resolves.toMatchObject({ title: "Account", blocks: [{ text: "Signed-in content" }] });

  expect(pageMocks.cdp).not.toHaveBeenCalled();
});

beforeEach(() => {
  pageMocks.attachDebugger.mockReset().mockResolvedValue({});
  pageMocks.executeScript.mockReset();
  pageMocks.executeScript.mockResolvedValueOnce([]).mockResolvedValueOnce([
    {
      result: {
        ok: true,
        value: {
          title: "Checkout",
          url: "https://shop.example.test/checkout",
          mode: "interactive",
          actions: [
            {
              id: "el-1",
              role: "button",
              name: "",
              state: {},
              verbs: ["click"],
            },
          ],
        },
      },
    },
  ]);
  pageMocks.cdp.mockReset().mockImplementation((_tabId: number, method: string) => {
    switch (method) {
      case "DOM.enable":
      case "Runtime.releaseObject":
        return Promise.resolve({});
      case "Accessibility.getFullAXTree":
        return Promise.resolve({
          nodes: [
            {
              nodeId: "ax-1",
              ignored: false,
              backendDOMNodeId: 7,
              role: { type: "role", value: "button" },
              name: { type: "computedString", value: "Submit order" },
            },
          ],
        });
      case "DOM.resolveNode":
        return Promise.resolve({ object: { objectId: "object-1" } });
      case "Runtime.callFunctionOn":
        return Promise.resolve({
          result: {
            value: {
              id: "el-1",
              tag: "button",
              disabled: false,
              inert: false,
              focused: false,
              editable: false,
              clickable: true,
            },
          },
        });
      default:
        return Promise.reject(new Error(`Unexpected CDP method ${method}`));
    }
  });
});

it("joins Accessibility Tree and DOM evidence through one live registry ref", async () => {
  const snapshot = await snapshotInTab({
    tab: resolvedTabFixture(),
    foreground: false,
    mode: "interactive",
    maxElements: 20,
  });

  expect(snapshot.actions).toEqual([
    {
      kind: "action",
      id: "el-1",
      role: "button",
      name: "Submit order",
      state: {},
      verbs: ["click"],
    },
  ]);
  expect(pageMocks.cdp).toHaveBeenCalledWith(7, "Accessibility.getFullAXTree", {});
  expect(pageMocks.cdp).toHaveBeenCalledWith(7, "Runtime.releaseObject", {
    objectId: "object-1",
  });
});
