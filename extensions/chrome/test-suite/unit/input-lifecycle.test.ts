import { beforeEach, expect, it, vi } from "vite-plus/test";
import { resolvedTabFixture } from "./resolved-tab-fixture.js";

type CdpEvent = {
  readonly tabId: number;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
};

const runtime = vi.hoisted(() => ({
  events: [] as Array<CdpEvent>,
  pressed: new Set<string>(),
  failNextHeldSleep: false,
  failMainKeyDown: false,
  targetResult: {
    found: true,
    x: 10,
    y: 20,
    rect: null,
    tag: "BUTTON",
  } as Record<string, unknown>,
  hitResult: { ok: true } as Record<string, unknown>,
}));

vi.mock("../../src/browser/platform-cdp.js", () => ({
  attachDebugger: vi.fn(async () => undefined),
  cdp: vi.fn(
    async (tabId: number, method: string, params: Readonly<Record<string, unknown>> = {}) => {
      runtime.events.push({ tabId, method, params });
      const type = params.type;
      const key = typeof params.key === "string" ? params.key : "";
      if (runtime.failMainKeyDown && type === "rawKeyDown" && key === "x") {
        throw new Error("main key down failed");
      }
      if (type === "keyDown" || type === "rawKeyDown") runtime.pressed.add(`key:${key}`);
      if (type === "keyUp") runtime.pressed.delete(`key:${key}`);
      if (type === "mousePressed") runtime.pressed.add("mouse:left");
      if (type === "mouseReleased") runtime.pressed.delete("mouse:left");
      if (type === "touchStart") runtime.pressed.add("touch:1");
      if (type === "touchEnd") runtime.pressed.delete("touch:1");
      return {};
    },
  ),
  executeScript: vi.fn(async (options: { readonly args?: ReadonlyArray<unknown> }) =>
    options.args?.length === 0
      ? [
          {
            result: {
              url: "https://input.test/",
              title: "Input",
              focus: "",
              scroll: "0,0",
              pageHash: 1,
            },
          },
        ]
      : [{ result: options.args?.length === 3 ? runtime.hitResult : runtime.targetResult }],
  ),
  pointerOrigin: vi.fn(() => ({ x: 10, y: 20 })),
  recordPointer: vi.fn(),
  rng: vi.fn((minimum: number) => minimum),
  sleep: vi.fn(async () => {
    if (runtime.failNextHeldSleep && runtime.pressed.size > 0) {
      runtime.failNextHeldSleep = false;
      throw new Error("input use failed");
    }
  }),
}));

vi.mock("../../src/browser/platform-targets.js", () => ({
  bringToFront: vi.fn(async () => undefined),
}));

import { chromeInputClick } from "../../src/browser/platform-input-click.js";
import { cdpKeyInfo, cdpTypeChar } from "../../src/browser/platform-input-shared.js";
import {
  chromeInputDrag,
  chromeInputScroll,
  chromeInputTap,
} from "../../src/browser/platform-input-pointer.js";
import { chromeInputKey, chromeInputType } from "../../src/browser/platform-input-text.js";

const tab = resolvedTabFixture(7, 1);

beforeEach(() => {
  Object.assign(globalThis, {
    chrome: {
      tabs: {
        get: vi.fn(async () => ({
          id: tab.id,
          windowId: tab.windowId,
          url: "https://input.test/",
          title: "Input",
          status: "complete",
        })),
      },
    },
  });
  runtime.events.length = 0;
  runtime.pressed.clear();
  runtime.failNextHeldSleep = false;
  runtime.failMainKeyDown = false;
  runtime.targetResult = { found: true, x: 10, y: 20, rect: null, tag: "BUTTON" };
  runtime.hitResult = { ok: true };
});

it.each(["界", "😀", "\u0301"])(
  "projects the Unicode code point %s as text input",
  async (value) => {
    expect(cdpKeyInfo(value)).toMatchObject({
      key: value,
      code: "",
      windowsVirtualKeyCode: 0,
      text: value,
    });

    await cdpTypeChar(tab.id, value);

    const keyEvents = runtime.events.filter(({ params }) =>
      ["keyDown", "keyUp"].includes(String(params.type)),
    );
    expect(keyEvents).toHaveLength(2);
    expect(keyEvents[0]?.params).toMatchObject({ type: "keyDown", key: value, text: value });
    expect(keyEvents[1]?.params).toMatchObject({ type: "keyUp", key: value });
    expect(runtime.pressed.size).toBe(0);
  },
);

it("derives shifted character events from the US key-layout owner", async () => {
  await cdpTypeChar(tab.id, "!");

  expect(runtime.events.map(({ params }) => [params.type, params.key, params.modifiers])).toEqual([
    ["keyDown", "Shift", 8],
    ["keyDown", "!", 8],
    ["keyUp", "!", 8],
    ["keyUp", "Shift", 0],
  ]);
  expect(runtime.pressed.size).toBe(0);
});

it("releases a character key when work between keyDown and keyUp fails", async () => {
  runtime.failNextHeldSleep = true;

  await expect(cdpTypeChar(tab.id, "x")).rejects.toThrow("input use failed");

  expect(runtime.events.map(({ params }) => [params.type, params.key])).toEqual([
    ["keyDown", "x"],
    ["keyUp", "x"],
  ]);
  expect(runtime.pressed.size).toBe(0);
});

it("releases every acquired modifier in reverse order when the main key cannot be pressed", async () => {
  runtime.failMainKeyDown = true;

  await expect(
    chromeInputKey({
      tab,
      foreground: false,
      key: "x",
      modifiers: { ctrlKey: true, shiftKey: true },
    }),
  ).rejects.toThrow("main key down failed");

  expect(runtime.events.map(({ params }) => [params.type, params.key, params.modifiers])).toEqual([
    ["keyDown", "Control", 2],
    ["keyDown", "Shift", 10],
    ["rawKeyDown", "x", 10],
    ["keyUp", "Shift", 2],
    ["keyUp", "Control", 0],
  ]);
  expect(runtime.pressed.size).toBe(0);
});

it("sends exactly one Enter after typed text", async () => {
  await chromeInputType({
    tab,
    foreground: false,
    text: "😀",
    pressEnter: true,
  });

  const enterDown = runtime.events.filter(
    ({ params }) => params.type === "keyDown" && params.key === "Enter",
  );
  expect(enterDown).toHaveLength(1);
  expect(runtime.events.some(({ params }) => params.key === "\r")).toBe(false);
  expect(runtime.pressed.size).toBe(0);
});

it("releases a click when its pressed interval fails", async () => {
  runtime.failNextHeldSleep = true;

  await expect(
    chromeInputClick({
      tab,
      foreground: false,
      x: 10,
      y: 20,
    }),
  ).rejects.toThrow("input use failed");

  expect(runtime.events.filter(({ params }) => params.type === "mouseReleased")).toHaveLength(1);
  expect(runtime.pressed.size).toBe(0);
});

it("rejects a ref without the click capability before pointer dispatch", async () => {
  runtime.targetResult = {
    found: false,
    verbMismatch: true,
    reason: "snapshot uid el-1 does not grant click",
    url: "https://input.test/",
  };

  await expect(chromeInputClick({ tab, foreground: false, uid: "el-1" })).rejects.toMatchObject({
    code: "action-verb-mismatch",
  });

  expect(runtime.events.filter(({ params }) => params.type === "mousePressed")).toHaveLength(0);
});

it("omits absent optional click fields from the transport result", async () => {
  const result = await chromeInputClick({ tab, foreground: false, x: 10, y: 20 });

  expect(result).not.toHaveProperty("requestedTag");
  expect(result).not.toHaveProperty("promotedFromTag");
  expect(result).not.toHaveProperty("resolvedUid");
  expect(Object.values(result)).not.toContain(undefined);
});

it("rejects a stale ref before pointer dispatch", async () => {
  runtime.targetResult = {
    found: false,
    staleUid: true,
    reason: "snapshot uid el-1 is stale; call chrome_snapshot again",
    url: "https://input.test/",
  };

  await expect(chromeInputClick({ tab, foreground: false, uid: "el-1" })).rejects.toMatchObject({
    code: "stale-action-ref",
  });
  expect(runtime.events.filter(({ params }) => params.type === "mousePressed")).toHaveLength(0);
});

it("rejects a hover-created blocker after movement and before mouse press", async () => {
  runtime.targetResult = {
    found: true,
    x: 10,
    y: 20,
    rect: null,
    tag: "BUTTON",
    resolvedUid: "el-1",
  };
  runtime.hitResult = { ok: false, blocker: "div#consent" };

  await expect(chromeInputClick({ tab, foreground: false, uid: "el-1" })).rejects.toMatchObject({
    code: "click-intercepted",
  });

  expect(runtime.events.filter(({ params }) => params.type === "mousePressed")).toHaveLength(0);
});

it("ends a touch contact when its pressed interval fails", async () => {
  runtime.failNextHeldSleep = true;

  await expect(
    chromeInputTap({
      tab,
      foreground: false,
      x: 10,
      y: 20,
    }),
  ).rejects.toThrow("input use failed");

  expect(runtime.events.filter(({ params }) => params.type === "touchEnd")).toHaveLength(1);
  expect(runtime.pressed.size).toBe(0);
});

it("releases a drag at its last confirmed point when movement fails", async () => {
  runtime.failNextHeldSleep = true;

  await expect(
    chromeInputDrag({
      tab,
      foreground: false,
      fromX: 10,
      fromY: 20,
      toX: 30,
      toY: 40,
      steps: 3,
    }),
  ).rejects.toThrow("input use failed");

  expect(
    runtime.events.find(({ params }) => params.type === "mouseReleased")?.params,
  ).toMatchObject({ x: 10, y: 20 });
  expect(runtime.pressed.size).toBe(0);
});

it("emits exactly the protocol-requested number of bounded scroll steps", async () => {
  await expect(
    chromeInputScroll({
      tab,
      foreground: false,
      deltaY: 120,
      steps: 3,
    }),
  ).resolves.toMatchObject({ steps: 3 });

  expect(runtime.events.filter(({ params }) => params.type === "mouseWheel")).toHaveLength(3);
});
