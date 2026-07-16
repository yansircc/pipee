import { usKeyLayoutForChar } from "./key-layout.js";
import { ACTION_BLOCKED_SELECTOR, ACTION_ELEMENT_SELECTOR } from "./action-elements.js";
import { BrowserRejected } from "./browser-command-failure.js";
import { cdp, executeScript, pointerOrigin, recordPointer, rng, sleep } from "./platform-cdp.js";
import { withResourceLease } from "./platform-resource-lease.js";
import type {
  CdpKeyInfo,
  CdpModifierState,
  InputPoint,
  InputRect,
  InputTargetResolution,
  PointLocator,
  ResolvedInputTarget,
} from "./platform-input-types.js";

// Resolve target -> {x, y, rect} in viewport coords by running tiny script in tab.
export async function resolveTargetInTab(
  tabId: number,
  params: PointLocator,
  options: { preferInteractive?: boolean; expectedVerb?: PiChromeActionVerb } = {},
): Promise<ResolvedInputTarget> {
  const results = await executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (
      selector: string | null | undefined,
      uid: string | null | undefined,
      x: number | null | undefined,
      y: number | null | undefined,
      preferInteractive: boolean,
      expectedVerb: PiChromeActionVerb | null,
      interactiveSelector: string,
      blockedSelector: string,
    ): InputTargetResolution => {
      let state = window.__PI_CHROME_STATE__;
      if (!state && selector) {
        state = {
          nextElementUid: 1,
          nextFrontierUid: 1,
          refs: new Map(),
          console: [],
          network: [],
          nextRequestId: 1,
          instrumentationInstalled: false,
          lastSnapshotDigest: null,
        };
        window.__PI_CHROME_STATE__ = state;
      }
      let el: Element | null = null;
      if (uid) {
        const ref = state?.refs.get(uid);
        el = ref?.kind === "element" ? ref.element : null;
        if (!el || !el.isConnected) {
          state?.refs.delete(uid);
          return {
            found: false,
            staleUid: true,
            reason: `snapshot uid ${uid} is stale; call chrome_snapshot again`,
            url: location.href,
          };
        }
        if (expectedVerb && (ref?.kind !== "element" || !ref.verbs.has(expectedVerb))) {
          return {
            found: false,
            verbMismatch: true,
            reason: `snapshot uid ${uid} does not grant ${expectedVerb}; take a fresh chrome_snapshot and use a ref whose Action Graph entry includes ${expectedVerb}`,
            url: location.href,
          };
        }
        state!.refs.delete(uid);
        state!.refs.set(uid, ref!);
      } else if (selector) {
        el = document.querySelector(selector);
      }
      if (el) {
        const requestedTag = el.tagName;
        let promotedFromTag: string | undefined;
        if (preferInteractive) {
          if (!el.matches?.(interactiveSelector)) {
            if (uid) {
              return {
                found: false,
                nonInteractive: true,
                reason: `Action ref ${uid} no longer resolves to the exact interactive element that issued it; take a fresh chrome_snapshot.`,
                url: location.href,
              };
            }
            const ancestor = el.closest?.(interactiveSelector);
            if (!ancestor) {
              return {
                found: false,
                nonInteractive: true,
                reason: `Target ${uid || selector || requestedTag} is <${String(requestedTag || "element").toLowerCase()}> text/content, not an interactive control. Use a ref whose Action Graph entry includes click.`,
                url: location.href,
              };
            }
            promotedFromTag = requestedTag;
            el = ancestor;
          }
          if (el.matches?.(blockedSelector) || el.closest?.("[inert]")) {
            return {
              found: false,
              invalidClickTarget: true,
              reason: `Target ${uid || selector || requestedTag} resolves to a disabled or inert <${String(el.tagName || "element").toLowerCase()}>. Take a fresh chrome_snapshot and choose a ref with click.`,
              url: location.href,
            };
          }
        }
        el.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
        const r = el.getBoundingClientRect();
        let resolvedUid: string | undefined;
        if (state) {
          for (const [key, registered] of state.refs) {
            if (registered.kind === "element" && registered.element === el) {
              resolvedUid = key;
              break;
            }
          }
          if (!resolvedUid) {
            if (!el.__piChromeUid) el.__piChromeUid = `el-${state.nextElementUid++}`;
            resolvedUid = el.__piChromeUid;
            state.refs.set(resolvedUid, {
              kind: "element",
              element: el,
              verbs: new Set(),
              context: false,
            });
          }
        }
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          },
          tag: el.tagName,
          requestedTag,
          promotedFromTag,
          resolvedUid,
          interactive: preferInteractive ? true : undefined,
          found: true,
        };
      }
      if (typeof x === "number" && typeof y === "number")
        return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [
      params.selector ?? null,
      params.uid ?? null,
      params.x ?? null,
      params.y ?? null,
      options.preferInteractive === true,
      options.expectedVerb ?? null,
      ACTION_ELEMENT_SELECTOR,
      ACTION_BLOCKED_SELECTOR,
    ],
  });
  const v = results?.[0]?.result;
  if (!v)
    throw new BrowserRejected("Could not resolve target element for Chrome input", {
      code: "action-target-not-found",
    });
  if (!v.found) {
    throw new BrowserRejected(
      v.reason ||
        "Invalid action target; call chrome_snapshot again and choose a ref with the required verb.",
      {
        code: v.staleUid
          ? "stale-action-ref"
          : v.verbMismatch
            ? "action-verb-mismatch"
            : "invalid-action-target",
        details: {
          ...(params.uid ? { ref: params.uid } : {}),
          ...(v.url ? { url: v.url } : {}),
        },
      },
    );
  }
  return v;
}

export async function assertTargetReceivesPoint(
  tabId: number,
  uid: string | undefined,
  point: InputPoint,
): Promise<void> {
  if (!uid) return;
  const results = await executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (targetUid: string, x: number, y: number) => {
      const ref = window.__PI_CHROME_STATE__?.refs.get(targetUid);
      const expected = ref?.kind === "element" ? ref.element : null;
      if (!expected || !expected.isConnected) return { ok: false as const, stale: true as const };
      const hit = document.elementFromPoint(x, y);
      if (!hit) return { ok: false as const, blocker: "no element" };
      const up = (node: Node | null): Node | null => {
        if (!node) return null;
        return node.parentNode || (node as ShadowRoot).host || null;
      };
      for (let node: Node | null = hit; node; node = up(node)) {
        if (node === expected) return { ok: true as const };
      }
      for (let node: Node | null = expected; node; node = up(node)) {
        if (node === hit) return { ok: true as const };
      }
      const hitLabel = hit.closest?.("label") as HTMLLabelElement | null;
      if (hitLabel && (hitLabel.control === expected || hitLabel.contains(expected)))
        return { ok: true as const };
      const expectedLabel = expected.closest?.("label");
      if (expectedLabel?.contains(hit)) return { ok: true as const };
      let blocker = hit.tagName.toLowerCase();
      if (hit.id) blocker += `#${hit.id}`;
      else if (typeof hit.className === "string" && hit.className.trim())
        blocker += `.${hit.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
      return { ok: false as const, blocker };
    },
    args: [uid, point.x, point.y],
  });
  const result = results?.[0]?.result;
  if (result?.ok === true) return;
  if (result?.stale)
    throw new BrowserRejected(`Action ref ${uid} became stale before input dispatch`, {
      code: "stale-action-ref",
      details: { ref: uid },
    });
  throw new BrowserRejected(
    `Action ref ${uid} is covered by <${result?.blocker || "unknown"}> at its click point; dismiss the blocker and take a fresh chrome_snapshot`,
    {
      code: "click-intercepted",
      details: {
        ref: uid,
        point,
        blocker: result?.blocker || "unknown",
      },
    },
  );
}

export function pickInsideRect(rect: InputRect): InputPoint;
export function pickInsideRect(rect: null | undefined): null;
export function pickInsideRect(rect: InputRect | null | undefined): InputPoint | null {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

export async function cdpMoveTo(tabId: number, x: number, y: number): Promise<void> {
  const origin = pointerOrigin(
    tabId,
    Math.max(20, Math.min(400, x - 200)),
    Math.max(20, Math.min(400, y - 200)),
  );
  const startX = origin.x;
  const startY = origin.y;
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: px,
      y: py,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  recordPointer(tabId, x, y);
}

export function cdpModifiersFor(mods: CdpModifierState | null | undefined): number {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

// Resolve a key to the CDP key event fields for the US layout.
// Using charCodeAt() for punctuation is wrong: e.g. "." is charCode 46 which collides
// with VK_DELETE, "-" is 45 (VK_INSERT), so app keydown handlers misfire and drop input.
export function cdpKeyInfo(key: string): CdpKeyInfo {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL: Readonly<Record<string, Omit<CdpKeyInfo, "key">>> = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
  };
  const codePoints = Array.from(key);
  if (codePoints.length === 1) {
    const ch = codePoints[0]!;
    const layout = usKeyLayoutForChar(ch);
    return {
      key: ch,
      code: layout.code,
      windowsVirtualKeyCode: layout.keyCode,
      text: ch,
    };
  }
  if (SPECIAL[key]) return { key, ...SPECIAL[key]! };
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

export async function cdpTypeChar(tabId: number, ch: string): Promise<void> {
  if (Array.from(ch).length !== 1)
    throw new Error("Chrome text input requires one Unicode code point");
  const layout = usKeyLayoutForChar(ch);
  const info = cdpKeyInfo(ch);
  const dispatchCharacter = (modifiers: number) =>
    withResourceLease(
      async () => {
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
          nativeVirtualKeyCode: info.windowsVirtualKeyCode,
          text: info.text,
          unmodifiedText: info.text,
          modifiers,
        });
      },
      () => sleep(rng(25, 90)),
      () =>
        cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: info.key,
          code: info.code,
          windowsVirtualKeyCode: info.windowsVirtualKeyCode,
          modifiers,
        }).then(() => undefined),
    );

  if (layout.needShift) {
    await withResourceLease(
      async () => {
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Shift",
          code: "ShiftLeft",
          windowsVirtualKeyCode: 16,
          modifiers: 8,
        });
      },
      async () => {
        await sleep(rng(8, 22));
        await dispatchCharacter(8);
      },
      async () => {
        await sleep(rng(5, 18));
        await cdp(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Shift",
          code: "ShiftLeft",
          windowsVirtualKeyCode: 16,
          modifiers: 0,
        });
      },
    );
  } else {
    await dispatchCharacter(0);
  }
  await sleep(rng(35, 130));
}
