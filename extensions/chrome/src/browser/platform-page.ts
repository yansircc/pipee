import {
  PAGE_HELPERS,
  installPiChromeInstrumentation,
  projectEvaluationValue,
} from "./injected/actions.js";
import type { WirePageCall } from "../protocol/schema.js";
import type { JsonValue } from "../protocol/json-value.js";
import {
  actionRefFromEvidence,
  mergeActionRefs,
  type ActionRef,
  type ContextRef,
  type FrontierRef,
} from "../protocol/action-graph.js";
import { BrowserRejected } from "./browser-command-failure.js";
import { COMMAND_DEADLINES_MS, SCREENSHOT_LIMITS } from "../protocol/bridge-contract.js";
import { EVALUATION_VALUE_CONTRACT } from "../protocol/evaluation-value-contract.js";
import {
  planFullPageTileGeometry,
  planScreenshotRasterGeometry,
} from "../protocol/screenshot-geometry.js";
import { SNAPSHOT_BUNDLE_PATH } from "./extension-runtime-assets.js";
import { accountScreenshotDataUrl } from "./screenshot-transport.js";
import { attachDebugger, cdp, cdpEval, cdpExceptionText, executeScript } from "./platform-cdp.js";
import type { CdpAxNode } from "./platform-cdp-types.js";
import { ACTION_BLOCKED_SELECTOR, ACTION_ELEMENT_SELECTOR } from "./action-elements.js";
import type { PageSnapshot } from "./injected/types.js";
import type { ReadPageResult } from "./injected/types.js";
import type { ElementLocator } from "./platform-input-types.js";
import { bringToFront, formatTab, type ResolvedTab } from "./platform-targets.js";

type PageOperation = WirePageCall["operation"];
type Operation<Kind extends PageOperation["kind"]> = Extract<
  PageOperation,
  { readonly kind: Kind }
>;
type PageActionContext = { readonly tab: ResolvedTab; readonly foreground: boolean };
type SnapshotParams = PageActionContext & Omit<Operation<"snapshot">, "kind">;
type ReadParams = PageActionContext & Omit<Operation<"read">, "kind">;
type InspectParams = PageActionContext &
  ElementLocator &
  Pick<Operation<"inspect">, "scrollIntoView">;
type EvaluateParams = PageActionContext &
  Omit<Operation<"evaluate">, "kind"> & {
    readonly evaluationTimeoutMs?: number | undefined;
  };
type ScreenshotParams = PageActionContext & Omit<Operation<"screenshot">, "kind">;
type SnapshotCapableContext = PageActionContext &
  Pick<Operation<"snapshot">, "maxElements"> & {
    readonly includeSnapshot?: boolean | undefined;
  };
type ScriptEnvelope<Value = unknown> = {
  readonly ok: boolean;
  readonly value?: Value;
  readonly error?: string;
};

type AxDomEvidence = {
  readonly id: string;
  readonly tag: string;
  readonly type?: string | undefined;
  readonly disabled: boolean;
  readonly inert: boolean;
  readonly checked?: boolean | undefined;
  readonly focused: boolean;
  readonly editable: boolean;
  readonly clickable: boolean;
};

const axValue = (value: CdpAxNode["role"]): string =>
  typeof value?.value === "string" ? value.value : "";

const axProperty = (node: CdpAxNode, name: string): string | number | boolean | undefined =>
  node.properties?.find((property) => property.name === name)?.value.value;

const isPotentialAxAction = (node: CdpAxNode): boolean => {
  const role = axValue(node.role).toLowerCase();
  return (
    [
      "button",
      "checkbox",
      "combobox",
      "link",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "radio",
      "searchbox",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem",
    ].includes(role) ||
    axProperty(node, "editable") === true ||
    axProperty(node, "focusable") === true
  );
};

const resolveAxDomEvidence = async (
  tabId: number,
  node: CdpAxNode,
  scopeUid: string | null,
): Promise<AxDomEvidence | undefined> => {
  const backendNodeId = node.backendDOMNodeId;
  if (backendNodeId === undefined) return undefined;
  const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object.objectId;
  if (!objectId) return undefined;
  try {
    const projected = await cdp(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(actionSelector, blockedSelector, scopeUid) {
        const element = this;
        if (!(element instanceof Element) || !element.isConnected) return null;
        if (scopeUid) {
          const scopeRef = globalThis.__PI_CHROME_STATE__?.refs.get(scopeUid);
          const root = scopeRef?.kind === "element" ? scopeRef.element : null;
          if (!root || (root !== element && !root.contains(element))) return null;
        }
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) return null;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return null;
        const remember = globalThis.__piChromeRememberElement;
        if (typeof remember !== "function") return null;
        const checked = "checked" in element ? Boolean(element.checked) : undefined;
        return {
          id: remember(element),
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || undefined,
          disabled: element.matches(blockedSelector),
          inert: Boolean(element.closest("[inert]")),
          checked,
          focused: document.activeElement === element,
          editable: element.matches("textarea,[contenteditable='true'],input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='hidden'])"),
          clickable: element.matches(actionSelector),
        };
      }`,
      arguments: [
        { value: ACTION_ELEMENT_SELECTOR },
        { value: ACTION_BLOCKED_SELECTOR },
        { value: scopeUid },
      ],
      returnByValue: true,
    });
    const value = projected.result?.value;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as AxDomEvidence)
      : undefined;
  } finally {
    await cdp(tabId, "Runtime.releaseObject", { objectId });
  }
};

const accessibilityActionsInTab = async (
  tabId: number,
  maxElements: number,
  scopeUid: string | null,
): Promise<Array<ActionRef>> => {
  await attachDebugger(tabId);
  await cdp(tabId, "DOM.enable", {});
  const tree = await cdp(tabId, "Accessibility.getFullAXTree", {});
  const candidates = tree.nodes
    .filter((node) => !node.ignored && isPotentialAxAction(node))
    .slice(0, maxElements);
  const actions = await Promise.all(
    candidates.map(async (node) => {
      const dom = await resolveAxDomEvidence(tabId, node, scopeUid);
      if (!dom) return undefined;
      return actionRefFromEvidence({
        ...dom,
        role: axValue(node.role) || dom.tag,
        name: axValue(node.name),
        disabled: axProperty(node, "disabled") === true || dom.disabled,
        checked:
          typeof axProperty(node, "checked") === "boolean"
            ? (axProperty(node, "checked") as boolean)
            : dom.checked,
        focused: axProperty(node, "focused") === true || dom.focused,
        editable: axProperty(node, "editable") === true || dom.editable,
      });
    }),
  );
  return actions.filter((action): action is ActionRef => action !== undefined);
};

const actionFingerprint = (actions: ReadonlyArray<ActionRef>): number => {
  let hash = 2166136261;
  for (const action of actions) {
    const text = `${action.id}\u0000${action.role}\u0000${action.name}\u0000${JSON.stringify(action.state)}\u0000${action.verbs.join(",")}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
};

type ActionContextGroup = {
  readonly rootUid: string | null;
  readonly role: string;
  readonly name: string;
  readonly actions: Array<ActionRef>;
};

export async function executeInTab<Args extends Array<unknown>, Result>(
  params: PageActionContext,
  func: (...args: Args) => Result,
  args: Args,
): Promise<Awaited<Result>> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);

  const serializedArgs = JSON.stringify(args)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const bindings = PAGE_HELPERS.map(
    (helper) => `const ${helper.name}=(${helper.toString()});`,
  ).join("\n");
  const expression = `(async()=>{${bindings}
const action=(${func.toString()});
const invocationArgs=${serializedArgs};
try{return {ok:true,value:await action(...invocationArgs)}}
catch(error){return {ok:false,error:error instanceof Error?(error.stack||error.message):String(error)}}
})()`;
  const result = await cdpEval(tab.id, expression);
  if (result.exceptionDetails) {
    throw new Error(
      `Failed to execute Chrome page action: ${cdpExceptionText(result.exceptionDetails) || "unknown error"}`,
    );
  }
  const envelope = result.result?.value;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("Chrome page action returned an invalid envelope");
  }
  if (envelope?.ok === false) {
    throw new Error(
      typeof envelope.error === "string" ? envelope.error : "Chrome page script failed",
    );
  }
  if (envelope.ok !== true) throw new Error("Chrome page action returned an invalid envelope");
  return envelope.value as Awaited<Result>;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate (via cdpEval) which is not
// subject to the page's CSP, fixing `chrome_evaluate` silently returning null / failing on
// pages that ship `script-src 'self'` without `'unsafe-eval'` (which blocks `eval`/`new Function`).
export async function evaluateInTab(params: EvaluateParams) {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  const expression = String(params.expression ?? "");
  const projectorSource = `(${projectEvaluationValue.toString()})`;
  const contractSource = JSON.stringify(EVALUATION_VALUE_CONTRACT);
  const awaitPromise = params.awaitPromise !== false;
  // The contract accepts one JavaScript expression. Project it to bounded JSON in-page before it
  // crosses the returnByValue boundary. A runtime SyntaxError is still a runtime failure: retrying
  // the same source as a statement body could execute its side effects twice.
  const userExpression = awaitPromise ? `(async()=>(${expression}))()` : `(()=>(${expression}))()`;
  const wrapper = awaitPromise
    ? `(async()=>{const __project=${projectorSource};const __contract=${contractSource};const __value=await ${userExpression};return __project(__value,__contract)})()`
    : `(()=>{const __project=${projectorSource};const __contract=${contractSource};const __value=${userExpression};return __project(__value,__contract)})()`;
  const evaluationOptions = {
    awaitPromise,
    timeout: params.evaluationTimeoutMs ?? COMMAND_DEADLINES_MS.defaultExecution,
  };

  const res = await cdpEval(tab.id, wrapper, evaluationOptions);
  if (res.exceptionDetails) {
    throw new Error(
      `chrome_evaluate failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`,
    );
  }
  const result = res.result;
  if (!result || result.type === "undefined" || result.value === undefined) {
    throw new Error("chrome_evaluate returned no projected JSON value");
  }
  return result.value as JsonValue;
}

type PostActionVerification =
  | { readonly status: "not-requested" }
  | { readonly status: "observed"; readonly snapshot: JsonValue }
  | { readonly status: "unavailable"; readonly reason: string };

type PostActionResult<Result> = {
  readonly action: Result;
  readonly verification: PostActionVerification;
};

const failureReason = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return (text || "Post-action snapshot failed").slice(0, 1_000);
};

export async function withPostActionVerification<Params extends SnapshotCapableContext, Result>(
  params: Params,
  actionFn: (params: Params) => Result | Promise<Result>,
  observeFn: (params: SnapshotParams) => Promise<unknown> = snapshotInTab,
): Promise<PostActionResult<Result>> {
  const action = await actionFn(params);
  if (!params.includeSnapshot) {
    return { action, verification: { status: "not-requested" } };
  }

  const observed = await observeFn({ ...params, foreground: false }).then(
    (snapshot): PostActionVerification => ({ status: "observed", snapshot: snapshot as JsonValue }),
    (cause: unknown): PostActionVerification => ({
      status: "unavailable",
      reason: failureReason(cause),
    }),
  );
  return { action, verification: observed };
}

// Snapshot/inspect run from a packaged MAIN-world script injected via
// chrome.scripting.executeScript({ files }). That file is free of eval/new Function, so it works
// on strict-CSP pages, and it installs globalThis.__piChromeSnapshotPage / __piChromeInspectTarget.
// It shares window.__PI_CHROME_STATE__ (same el- uid scheme) with the CDP-injected input helpers.
export async function snapshotInTab(params: SnapshotParams) {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  const args = [
    params.maxElements || 80,
    params.containingText ?? null,
    params.role ?? null,
    params.nearUid ?? null,
    params.mode || "auto",
    params.query ?? null,
    params.maxTextChars ?? null,
    params.ref?.replace(/^@/, "") ?? null,
  ];
  await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: [SNAPSHOT_BUNDLE_PATH],
  });
  const results = await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const snapshotPage = globalThis.__piChromeSnapshotPage;
        if (typeof snapshotPage !== "function")
          throw new Error("Snapshot bundle did not install __piChromeSnapshotPage");
        return {
          ok: true,
          value: snapshotPage(...(invocationArgs as Parameters<PiChromeSnapshotPage>)),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.stack || error.message : String(error),
        };
      }
    },
    args: [args],
  });
  const first = results?.[0];
  if (first?.error) {
    const message =
      typeof first.error === "string"
        ? first.error
        : first.error.message || JSON.stringify(first.error);
    throw new Error(message);
  }
  const envelope = first?.result as ScriptEnvelope | undefined;
  if (envelope?.ok === false) {
    if (params.ref)
      throw new BrowserRejected(
        envelope.error || `Observation ref ${params.ref} could not be expanded`,
        {
          code: "stale-observation-ref",
          details: { ref: params.ref },
        },
      );
    throw new Error(envelope.error || "Chrome snapshot script failed");
  }
  const snapshot = envelope?.value as PageSnapshot | undefined;
  if (!snapshot) throw new Error("Chrome snapshot returned no value");
  const expansion = snapshot.observationExpansion;
  const accessibilityActions = await accessibilityActionsInTab(
    tab.id,
    2_048,
    expansion?.rootUid ?? null,
  );
  const allActions = mergeActionRefs(snapshot.actions, accessibilityActions, 2_048);
  if (
    expansion &&
    expansion.fingerprint !== 0 &&
    actionFingerprint(allActions) !== expansion.fingerprint
  ) {
    throw new BrowserRejected(
      `Observation frontier ${params.ref} is stale; take a fresh chrome_snapshot`,
      {
        code: "stale-observation-frontier",
        details: { ref: params.ref ?? "", url: snapshot.url },
      },
    );
  }
  const offset = expansion?.offset ?? 0;
  const limit = params.maxElements || 80;
  const actions = allActions.slice(offset, offset + limit);
  const contextByAction = snapshot.actionContextById ?? {};
  const groups = new Map<string, ActionContextGroup>();
  for (const action of allActions) {
    const context = expansion?.rootUid
      ? {
          uid: expansion.rootUid,
          role: "region",
          label: "Expanded context",
        }
      : contextByAction[action.id];
    const key = context?.uid ?? "__page__";
    const group = groups.get(key) ?? {
      rootUid: context?.uid ?? null,
      role: context?.role || "document",
      name: context?.label || snapshot.title || "Page",
      actions: [],
    };
    group.actions.push(action);
    groups.set(key, group);
  }
  const selectedIds = new Set(actions.map(({ id }) => id));
  const contextRefs: Array<ContextRef> = [];
  const frontierDescriptors: Array<{
    readonly rootUid: string | null;
    readonly offset: number;
    readonly fingerprint: number;
    readonly name: string;
    readonly omittedCount: number;
  }> = [];
  for (const group of groups.values()) {
    const shownActionCount = group.actions.filter(({ id }) => selectedIds.has(id)).length;
    if (group.rootUid) {
      contextRefs.push({
        kind: "context",
        id: group.rootUid,
        role: group.role,
        name: group.name,
        actionCount: group.actions.length,
        shownActionCount,
      });
    }
    if (shownActionCount < group.actions.length) {
      const consumedActionCount = expansion ? offset + shownActionCount : shownActionCount;
      if (consumedActionCount >= group.actions.length) continue;
      frontierDescriptors.push({
        rootUid: group.rootUid,
        offset: consumedActionCount,
        fingerprint: group.rootUid && !expansion ? 0 : actionFingerprint(group.actions),
        name: group.name,
        omittedCount: group.actions.length - consumedActionCount,
      });
    }
  }
  const registration = await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: (
      issuedActions: ReadonlyArray<{
        readonly id: string;
        readonly verbs: ReadonlyArray<PiChromeActionVerb>;
      }>,
      contextIds: ReadonlyArray<string>,
      frontierInputs: ReadonlyArray<{
        readonly rootUid: string | null;
        readonly offset: number;
        readonly fingerprint: number;
        readonly name: string;
        readonly omittedCount: number;
      }>,
    ) => {
      const grant = globalThis.__piChromeGrantActionVerbs;
      const markContext = globalThis.__piChromeMarkContextRef;
      const register = globalThis.__piChromeRegisterFrontier;
      if (
        typeof grant !== "function" ||
        typeof markContext !== "function" ||
        typeof register !== "function"
      )
        throw new Error("Snapshot bundle did not install observation ref helpers");
      for (const action of issuedActions) grant(action.id, action.verbs);
      for (const contextId of contextIds) markContext(contextId);
      return frontierInputs.map((frontier) => ({
        id: register({
          projection: "actions",
          rootUid: frontier.rootUid,
          offset: frontier.offset,
          fingerprint: frontier.fingerprint,
        }),
        name: frontier.name,
        omittedCount: frontier.omittedCount,
      }));
    },
    args: [
      actions.map(({ id, verbs }) => ({ id, verbs })),
      contextRefs.map(({ id }) => id),
      frontierDescriptors,
    ],
  });
  const frontiers: Array<FrontierRef> = (registration?.[0]?.result ?? []).map(
    (frontier: { readonly id: string; readonly name: string; readonly omittedCount: number }) => ({
      kind: "frontier",
      projection: "actions",
      ...frontier,
    }),
  );
  const {
    actionContextById: _actionContextById,
    observationExpansion: _observationExpansion,
    ...publicSnapshot
  } = snapshot;
  return {
    ...publicSnapshot,
    actions,
    contexts: contextRefs,
    frontiers,
  } satisfies PageSnapshot;
}

export async function readInTab(params: ReadParams): Promise<ReadPageResult> {
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: [SNAPSHOT_BUNDLE_PATH],
  });
  const results = await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: (
      maxChars: number,
      view: "content" | "outline",
      query: string | null,
      ref: string | null,
    ) => {
      try {
        const readPage = globalThis.__piChromeReadPage;
        if (typeof readPage !== "function")
          throw new Error("Snapshot bundle did not install __piChromeReadPage");
        return { ok: true as const, value: readPage(maxChars, view, query, ref) };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.stack || error.message : String(error),
        };
      }
    },
    args: [
      params.maxChars ?? 12_000,
      params.view ?? "content",
      params.query ?? null,
      params.ref?.replace(/^@/, "") ?? null,
    ],
  });
  const envelope = results?.[0]?.result;
  if (envelope?.ok === false) {
    if (params.ref)
      throw new BrowserRejected(
        envelope.error || `Content ref ${params.ref} could not be expanded`,
        {
          code: "stale-content-ref",
          details: { ref: params.ref },
        },
      );
    throw new Error(envelope.error || "chrome_read failed");
  }
  if (envelope?.ok !== true) throw new Error("chrome_read returned no value");
  return envelope.value;
}

export async function inspectInTab(params: InspectParams) {
  if (!params.uid && !params.selector) throw new Error("chrome_inspect requires uid or selector");
  const { tab } = params;
  if (params.foreground) await bringToFront(tab);
  const args = [params.uid ?? null, params.selector ?? null, params.scrollIntoView === true];
  await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: [SNAPSHOT_BUNDLE_PATH],
  });
  const results = await executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const inspectTarget = globalThis.__piChromeInspectTarget;
        if (typeof inspectTarget !== "function")
          throw new Error("Snapshot bundle did not install __piChromeInspectTarget");
        return {
          ok: true,
          value: inspectTarget(...(invocationArgs as Parameters<PiChromeInspectTarget>)),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.stack || error.message : String(error),
        };
      }
    },
    args: [args],
  });
  const first = results?.[0];
  if (first?.error) {
    const message =
      typeof first.error === "string"
        ? first.error
        : first.error.message || JSON.stringify(first.error);
    throw new Error(message);
  }
  const envelope = first?.result as ScriptEnvelope | undefined;
  if (envelope?.ok === false) {
    throw new Error(envelope.error || "Chrome inspect script failed");
  }
  return envelope?.value;
}

// The page boundary owns source composition; the debugger session owner owns registration,
// navigation generation, and removal as one per-tab lease.
export function navigationInitScriptSource(userSource?: string): string {
  const earlyCaptureSource = `(${installPiChromeInstrumentation.toString()})();`;
  return userSource ? `${earlyCaptureSource}\n${userSource}` : earlyCaptureSource;
}

export async function takeScreenshot(params: ScreenshotParams) {
  const { tab } = params;
  await attachDebugger(tab.id);
  const metrics = await cdp(tab.id, "Page.getLayoutMetrics", {});
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
  const dprResult = await cdpEval(tab.id, "window.devicePixelRatio");
  const dpr = dprResult.result?.value;
  const resolvedDpr = typeof dpr === "number" ? dpr : Number.NaN;

  const capture = async (clip?: { x: number; y: number; width: number; height: number }) => {
    const captured = await cdp(tab.id, "Page.captureScreenshot", {
      format: params.format,
      quality: params.format === "jpeg" ? params.quality : undefined,
      fromSurface: true,
      captureBeyondViewport: clip !== undefined,
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return `data:image/${params.format};base64,${captured.data}`;
  };

  if (params.capture.kind === "full-page-tiles") {
    const plan = planFullPageTileGeometry(
      {
        width: content.width,
        height: content.height,
        viewportHeight: viewport.clientHeight,
        dpr: resolvedDpr,
      },
      SCREENSHOT_LIMITS,
    );
    if (!plan.ok) throw new Error(plan.message);
    const tiles: Array<{ readonly y: number; readonly dataUrl: string }> = [];
    let capturedBytes = 0;
    for (const tile of plan.tiles) {
      const dataUrl = await capture({
        x: content.x,
        y: content.y + tile.y,
        width: content.width,
        height: tile.height,
      });
      const budget = accountScreenshotDataUrl(capturedBytes, dataUrl);
      if (!budget.ok) {
        throw new Error(
          `Full-page screenshot transport is ${budget.usedBytes} bytes; limit is ${budget.limitBytes} bytes`,
        );
      }
      capturedBytes = budget.usedBytes;
      tiles.push({ y: tile.y, dataUrl });
    }
    return {
      kind: "tile-set",
      format: params.format,
      tab: await formatTab(await chrome.tabs.get(tab.id)),
      dimensions: {
        width: content.width,
        height: content.height,
        viewportHeight: viewport.clientHeight,
        dpr: resolvedDpr,
      },
      tiles,
    };
  }

  const raster = planScreenshotRasterGeometry(
    {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      dpr: resolvedDpr,
    },
    SCREENSHOT_LIMITS,
  );
  if (!raster.ok) throw new Error(raster.message);
  const dataUrl = await capture();
  const budget = accountScreenshotDataUrl(0, dataUrl);
  if (!budget.ok) {
    throw new Error(
      `Screenshot transport is ${budget.usedBytes} bytes; limit is ${budget.limitBytes} bytes`,
    );
  }
  return {
    kind: "image",
    format: params.format,
    dataUrl,
    tab: await formatTab(await chrome.tabs.get(tab.id)),
  };
}
