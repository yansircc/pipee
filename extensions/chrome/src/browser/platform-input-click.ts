import { attachDebugger, cdp, executeScript, rng, sleep } from "./platform-cdp.js";
import { bringToFront } from "./platform-targets.js";
import {
  assertTargetReceivesPoint,
  cdpMoveTo,
  pickInsideRect,
  resolveTargetInTab,
} from "./platform-input-shared.js";
import type {
  ChromeInputClickParams,
  ChromeInputClickResult,
  ChromeInputHoverParams,
  ChromeInputHoverResult,
  ClickDispatchResult,
  ClickOutcome,
  ClickState,
} from "./platform-input-types.js";
import { withResourceLease } from "./platform-resource-lease.js";

async function captureClickState(tabId: number): Promise<ClickState> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let page: Omit<ClickState, "status"> | undefined;
  try {
    const results = await executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: () => {
        const active = document.activeElement;
        const focus =
          active && active !== document.body && active !== document.documentElement
            ? [active.tagName, active.id || "", active.getAttribute?.("role") || ""].join("|")
            : "";
        const body = document.body;
        const text = body ? (body.innerText || "").slice(0, 4000) : "";
        let inputs = "";
        if (body) {
          for (const el of body.querySelectorAll("input,textarea,select")) {
            if (inputs.length >= 4000) break;
            inputs += `${(el as HTMLInputElement).value || ""}\x00`;
          }
        }
        const source = body
          ? `${text}|${inputs}|${body.getElementsByTagName("*").length}|${document.documentElement.scrollHeight}`
          : "";
        let pageHash = 2166136261;
        for (let i = 0; i < source.length; i++) {
          pageHash ^= source.charCodeAt(i);
          pageHash = Math.imul(pageHash, 16777619);
        }
        return {
          url: location.href,
          title: document.title,
          focus,
          scroll: `${Math.round(scrollX)},${Math.round(scrollY)}`,
          pageHash: pageHash >>> 0,
        };
      },
      args: [],
    });
    page = results?.[0]?.result;
  } catch {
    page = undefined;
  }
  return {
    url: page?.url || tab?.url || "",
    title: page?.title || tab?.title || "",
    status: tab?.status || "",
    focus: page?.focus || "",
    scroll: page?.scroll || "",
    pageHash: page?.pageHash,
  };
}

function buildClickOutcome(before: ClickState, after: ClickState): ClickOutcome {
  const observedChanges: ClickOutcome["observedChanges"] = [];
  const urlChanged = Boolean(before?.url && after?.url && before.url !== after.url);
  const titleChanged = Boolean(before?.title !== after?.title && (before?.title || after?.title));
  const focusChanged = Boolean(before?.focus !== after?.focus && (before?.focus || after?.focus));
  const scrollChanged = Boolean(
    before?.scroll !== after?.scroll && (before?.scroll || after?.scroll),
  );
  const pageChanged = Boolean(
    before?.pageHash !== undefined &&
    after?.pageHash !== undefined &&
    before.pageHash !== after.pageHash,
  );
  if (urlChanged) observedChanges.push("url");
  if (after?.status === "loading") observedChanges.push("navigation-pending");
  if (titleChanged) observedChanges.push("title");
  if (focusChanged) observedChanges.push("focus");
  if (scrollChanged) observedChanges.push("scroll");
  if (pageChanged) observedChanges.push("page");
  return {
    outcome: observedChanges.length ? "effect-observed" : "input-dispatched-no-observable-effect",
    observedChanges,
    urlChanged,
    titleChanged,
    focusChanged,
    scrollChanged,
    pageChanged,
    urlBefore: before?.url || "",
    urlAfter: after?.url || "",
  };
}

async function finalizeClickResult(
  tabId: number,
  before: ClickState,
  result: ClickDispatchResult,
): Promise<ChromeInputClickResult> {
  const startedAt = Date.now();
  let after = await captureClickState(tabId);
  let outcome = buildClickOutcome(before, after);
  if (!outcome.urlChanged && !outcome.titleChanged && !outcome.pageChanged) {
    await sleep(220);
    after = await captureClickState(tabId);
    outcome = buildClickOutcome(before, after);
  }
  return { ...result, ...outcome, observedAfterMs: Date.now() - startedAt };
}

export async function chromeInputClick(
  params: ChromeInputClickParams,
): Promise<ChromeInputClickResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  const before = await captureClickState(tab.id);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params, {
    preferInteractive: true,
    ...(params.uid ? { expectedVerb: "click" as const } : {}),
  });
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await assertTargetReceivesPoint(tab.id, resolved.resolvedUid, point);
  await withResourceLease(
    async () => {
      await cdp(tab.id, "Input.dispatchMouseEvent", {
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
    () => sleep(rng(45, 140)),
    () =>
      cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "mouse",
      }).then(() => undefined),
  );
  const result: ClickDispatchResult = {
    input: "chrome",
    x: point.x,
    y: point.y,
    tag: resolved.tag,
    ...(resolved.requestedTag === undefined ? {} : { requestedTag: resolved.requestedTag }),
    ...(resolved.promotedFromTag === undefined
      ? {}
      : { promotedFromTag: resolved.promotedFromTag }),
    ...(resolved.resolvedUid === undefined ? {} : { resolvedUid: resolved.resolvedUid }),
  };
  return finalizeClickResult(tab.id, before, result);
}

export async function chromeInputHover(
  params: ChromeInputHoverParams,
): Promise<ChromeInputHoverResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}
