import { attachDebugger, cdp, rng, sleep } from "./platform-cdp.js";
import { bringToFront } from "./platform-targets.js";
import {
  cdpKeyInfo,
  cdpModifiersFor,
  cdpMoveTo,
  cdpTypeChar,
  pickInsideRect,
  resolveTargetInTab,
} from "./platform-input-shared.js";
import type {
  ChromeInputFillParams,
  ChromeInputKeyParams,
  ChromeInputKeyResult,
  ChromeInputTextResult,
  ChromeInputTypeParams,
} from "./platform-input-types.js";
import { withResourceLease } from "./platform-resource-lease.js";

const focusInputTarget = async (
  tabId: number,
  params: {
    readonly selector?: string | null | undefined;
    readonly uid?: string | null | undefined;
  },
  expectedVerb?: PiChromeActionVerb,
): Promise<void> => {
  if (!(params.selector || params.uid)) return;
  const resolved = await resolveTargetInTab(
    tabId,
    params,
    params.uid && expectedVerb ? { expectedVerb } : {},
  );
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tabId, point.x, point.y);
  await withResourceLease(
    async () => {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
        force: 0.5,
      });
    },
    () => sleep(rng(45, 110)),
    () =>
      cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      }).then(() => undefined),
  );
  await sleep(rng(50, 120));
};

export async function chromeInputKey(params: ChromeInputKeyParams): Promise<ChromeInputKeyResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  await focusInputTarget(tab.id, params, "press");
  const key = String(params.key || "");
  if (!key) throw new Error("chrome_press: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  const modOrder: Array<{ key: string; code: string; vk: number; bit: number }> = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91, bit: 4 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17, bit: 2 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18, bit: 1 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16, bit: 8 });
  const info = cdpKeyInfo(key);

  const dispatchKey = () =>
    withResourceLease(
      async () => {
        await cdp(tab.id, "Input.dispatchKeyEvent", {
          type: modBits ? "rawKeyDown" : "keyDown",
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
          nativeVirtualKeyCode: info.windowsVirtualKeyCode,
          text: modBits ? "" : info.text,
          unmodifiedText: modBits ? "" : info.text,
          modifiers: modBits,
        });
      },
      () => sleep(rng(25, 90)),
      () =>
        cdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
          modifiers: modBits,
        }).then(() => undefined),
    );

  const withModifiers = (index: number, heldBits: number): Promise<void> => {
    const modifier = modOrder[index];
    if (!modifier) return dispatchKey();
    const pressedBits = heldBits | modifier.bit;
    return withResourceLease(
      async () => {
        await cdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode: modifier.vk,
          modifiers: pressedBits,
        });
      },
      async () => {
        await sleep(rng(6, 18));
        await withModifiers(index + 1, pressedBits);
      },
      async () => {
        await sleep(rng(5, 18));
        await cdp(tab.id, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: modifier.key,
          code: modifier.code,
          windowsVirtualKeyCode: modifier.vk,
          modifiers: heldBits,
        });
      },
    );
  };

  await withModifiers(0, 0);
  return { input: "chrome", key: info.key, modifiers: mods };
}

export async function chromeInputType(
  params: ChromeInputTypeParams,
): Promise<ChromeInputTextResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  await focusInputTarget(tab.id, params);
  const text = String(params.text || "");
  for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
  if (params.pressEnter) await chromeInputKey({ ...params, key: "Enter" });
  return { input: "chrome", length: text.length };
}

export async function chromeInputFill(
  params: ChromeInputFillParams,
): Promise<ChromeInputTextResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome_fill: selector or ref required");
  const resolved = await resolveTargetInTab(
    tab.id,
    params,
    params.uid ? { expectedVerb: "fill" } : {},
  );
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  // Triple-click selects all in input fields.
  for (let i = 1; i <= 3; i++) {
    await withResourceLease(
      async () => {
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
          clickCount: i,
          pointerType: "mouse",
          force: 0.5,
        });
      },
      () => sleep(rng(20, 60)),
      () =>
        cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 0,
          clickCount: i,
          pointerType: "mouse",
        }).then(() => undefined),
    );
    await sleep(rng(20, 60));
  }
  // Delete selection.
  await withResourceLease(
    async () => {
      await cdp(tab.id, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      });
    },
    async () => undefined,
    () =>
      cdp(tab.id, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Delete",
        code: "Delete",
        windowsVirtualKeyCode: 46,
      }).then(() => undefined),
  );
  await sleep(rng(20, 60));
  const text = String(params.text || "");
  for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
  if (params.submit) await chromeInputKey({ ...params, key: "Enter" });
  return { input: "chrome", length: text.length };
}
