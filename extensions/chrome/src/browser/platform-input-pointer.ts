import { attachDebugger, cdp, rng, sleep } from "./platform-cdp.js";
import { bringToFront } from "./platform-targets.js";
import { cdpMoveTo, pickInsideRect, resolveTargetInTab } from "./platform-input-shared.js";
import type {
  ChromeInputDragParams,
  ChromeInputDragResult,
  ChromeInputScrollParams,
  ChromeInputScrollResult,
  ChromeInputTapParams,
  ChromeInputTapResult,
  ChromeInputUploadParams,
  ChromeInputUploadResult,
} from "./platform-input-types.js";
import { withResourceLease } from "./platform-resource-lease.js";

export async function chromeInputScroll(
  params: ChromeInputScrollParams,
): Promise<ChromeInputScrollResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved =
    params.selector || params.uid
      ? await resolveTargetInTab(tab.id, params)
      : { x: 100, y: 100, rect: null };
  const x = resolved.rect
    ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2
    : resolved.x;
  const y = resolved.rect
    ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2
    : resolved.y;
  const totalY = params.deltaY ?? 0;
  const totalX = params.deltaX ?? 0;
  // Profile mimics a trackpad flick: short ramp-up (~15% of events), then geometric decay
  // with a ~12% drop per event. Gives momentum tail tests something to find, and the small
  // tail deltas (a handful of <20px events) put IntersectionObserver thresholds in range.
  const steps = params.steps ?? 24;
  const peakIndex = Math.max(1, Math.floor(steps * 0.15));
  const weights = Array.from({ length: steps }, (_, index) =>
    index <= peakIndex ? 0.5 + 0.5 * (index / peakIndex) : Math.pow(0.88, index - peakIndex),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < steps; index++) {
    const dy = totalY * (weights[index]! / totalWeight);
    const dx = totalX * (weights[index]! / totalWeight);
    await cdp(tab.id, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: dx,
      deltaY: dy,
      pointerType: "mouse",
    });
    // Sleep one+ frame so IntersectionObserver / rAF samples can run between events.
    await sleep(rng(22, 48));
  }
  return { input: "chrome", deltaX: totalX, deltaY: totalY, steps };
}

export async function chromeInputTap(params: ChromeInputTapParams): Promise<ChromeInputTapResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved =
    params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number")
      ? await resolveTargetInTab(tab.id, params)
      : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = {
    x: point.x,
    y: point.y,
    radiusX: 8,
    radiusY: 8,
    rotationAngle: 0,
    force: 0.5,
    id: 1,
  };
  await withResourceLease(
    async () => {
      await cdp(tab.id, "Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [tp],
      });
    },
    () => sleep(rng(40, 110)),
    () =>
      cdp(tab.id, "Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      }).then(() => undefined),
  );
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

export async function chromeInputDrag(
  params: ChromeInputDragParams,
): Promise<ChromeInputDragResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, {
    selector: params.fromSelector ?? null,
    uid: params.fromUid ?? null,
    x: params.fromX ?? null,
    y: params.fromY ?? null,
  });
  const to = await resolveTargetInTab(tab.id, {
    selector: params.toSelector ?? null,
    uid: params.toUid ?? null,
    x: params.toX ?? null,
    y: params.toY ?? null,
  });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  const steps = params.steps || 20;
  const lastPoint = { ...fp };
  await withResourceLease(
    async () => {
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: fp.x,
        y: fp.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
        force: 0.5,
      });
    },
    async () => {
      await sleep(rng(60, 140));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t * t * (3 - 2 * t);
        const wobble = Math.sin(t * Math.PI) * 6;
        const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
        const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
        await cdp(tab.id, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "left",
          buttons: 1,
          pointerType: "mouse",
        });
        lastPoint.x = x;
        lastPoint.y = y;
        await sleep(rng(10, 26));
      }
    },
    () =>
      cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: lastPoint.x,
        y: lastPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      }).then(() => undefined),
  );
  return { input: "chrome", from: fp, to: tp, steps };
}

export async function chromeInputUpload(
  params: ChromeInputUploadParams,
): Promise<ChromeInputUploadResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(params.uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const ref = uid && state ? state.refs.get(uid) : null;
    if (uid && (ref?.kind !== "element" || !ref.verbs.has("upload"))) throw new Error("Action ref does not grant upload");
    const el = ref?.kind === "element" ? ref.element : (selector ? document.querySelector(selector) : null);
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tab.id, "Runtime.evaluate", {
    expression,
    objectGroup: "pi-chrome-upload",
    includeCommandLineAPI: false,
    returnByValue: false,
  });
  const objectId = evaluated.result?.objectId;
  if (evaluated.exceptionDetails && !objectId) {
    throw new Error(evaluated.exceptionDetails.text || "Could not resolve file input");
  }
  if (!objectId) throw new Error("Could not resolve file input object");
  await withResourceLease(
    async () => objectId,
    async (leasedObjectId) => {
      if (evaluated.exceptionDetails) {
        throw new Error(evaluated.exceptionDetails.text || "Could not resolve file input");
      }
      await cdp(tab.id, "DOM.enable", {});
      const requested = await cdp(tab.id, "DOM.requestNode", { objectId: leasedObjectId });
      if (!requested.nodeId) throw new Error("Could not resolve file input node");
      await cdp(tab.id, "DOM.setFileInputFiles", {
        nodeId: requested.nodeId,
        files: paths,
      });
      const dispatched = await cdp(tab.id, "Runtime.callFunctionOn", {
        objectId: leasedObjectId,
        functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
        returnByValue: true,
      });
      if (dispatched.exceptionDetails) {
        throw new Error(dispatched.exceptionDetails.text || "Could not dispatch file input events");
      }
    },
    (leasedObjectId) =>
      cdp(tab.id, "Runtime.releaseObject", { objectId: leasedObjectId }).then(() => undefined),
  );
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}
// ===============================================================
