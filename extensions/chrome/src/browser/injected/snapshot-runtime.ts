import { ACTION_ELEMENT_SELECTOR, actionRefForElementSummary } from "../action-elements.js";
import {
  accessibleLabel,
  getPiChromeState,
  isElementVisible,
  lookupPiChromeElement,
  lookupFrontier,
  prunePiChromeElements,
  registerFrontier,
  rectSummary,
  rememberElement,
  roleOf,
  selectorFor,
  textOf,
} from "./snapshot-core.js";
import {
  activeElementSummary,
  diffSnapshot,
  digestFor,
  modalSummary,
  queryMatches,
  visibleTextSnippets,
} from "./snapshot-query.js";
import {
  contentBlocks,
  formSummaries,
  isInViewport,
  layoutSections,
  pageMap,
  summarizeElement,
} from "./snapshot-summary.js";
import type { PageSnapshot, ReadPageResult, ReadView, SnapshotMode } from "./types.js";

const contentFingerprint = (
  blocks: ReadonlyArray<{ readonly uid: string; readonly kind: string; readonly text: string }>,
): number => {
  let hash = 2166136261;
  for (const block of blocks) {
    const value = `${block.uid}\u0000${block.kind}\u0000${block.text}`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
};

export function snapshotPage(
  maxElements: number,
  containingText: string | null | undefined,
  roleFilter: string | null | undefined,
  nearUid: string | null | undefined,
  mode: string | null | undefined,
  query: string | null | undefined,
  maxTextChars: number | null | undefined,
  observationRef: string | null | undefined,
): PageSnapshot {
  const state = getPiChromeState();
  prunePiChromeElements(state);
  mode = (
    ["auto", "interactive", "forms", "pageMap", "text", "changes", "full"] as ReadonlyArray<
      string | null | undefined
    >
  ).includes(mode)
    ? mode
    : "auto";
  const fullTextLimit = Number(
    maxTextChars || (mode === "full" ? 30000 : mode === "text" ? 18000 : 6000),
  );
  let actionRoot: Document | Element = document;
  let expansion: PageSnapshot["observationExpansion"];
  if (observationRef) {
    const frontier = lookupFrontier(observationRef);
    if (frontier) {
      if (frontier.projection !== "actions")
        throw new Error(`Frontier ${observationRef} belongs to chrome_read, not chrome_snapshot`);
      const root = frontier.rootUid ? lookupPiChromeElement(frontier.rootUid) : document;
      if (!root)
        throw new Error(`Frontier ${observationRef} is stale; take a fresh chrome_snapshot`);
      actionRoot = root;
      expansion = {
        rootUid: frontier.rootUid,
        offset: frontier.offset,
        fingerprint: frontier.fingerprint,
      };
    } else {
      const stateRef = state.refs.get(observationRef);
      if (stateRef?.kind !== "element" || !stateRef.context || !stateRef.element.isConnected)
        throw new Error(
          `Observation ref ${observationRef} is stale or is not an expandable context`,
        );
      actionRoot = stateRef.element;
      expansion = { rootUid: observationRef, offset: 0, fingerprint: 0 };
    }
  }
  let candidates = Array.from(actionRoot.querySelectorAll(ACTION_ELEMENT_SELECTOR));
  if (actionRoot instanceof Element && actionRoot.matches(ACTION_ELEMENT_SELECTOR)) {
    candidates.unshift(actionRoot);
  }
  if (containingText) {
    const needle = String(containingText).toLowerCase();
    candidates = candidates.filter((element) =>
      accessibleLabel(element).toLowerCase().includes(needle),
    );
  }
  if (roleFilter) {
    const wanted = String(roleFilter).toLowerCase();
    candidates = candidates.filter(
      (element) => roleOf(element) === wanted || element.tagName.toLowerCase() === wanted,
    );
  }
  let near;
  if (nearUid) near = lookupPiChromeElement(nearUid);
  if (near) {
    const nearRect = near.getBoundingClientRect();
    const cx = nearRect.left + nearRect.width / 2;
    const cy = nearRect.top + nearRect.height / 2;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const da = Math.hypot(ra.left + ra.width / 2 - cx, ra.top + ra.height / 2 - cy);
      const db = Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy);
      return da - db;
    });
  } else {
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const avis = isInViewport(a) ? 0 : 1;
      const bvis = isInViewport(b) ? 0 : 1;
      return avis - bvis || ar.top - br.top || ar.left - br.left;
    });
  }
  const visibleCandidates = candidates.filter(isElementVisible);
  const elements = visibleCandidates
    .slice(0, 2_048)
    .map((element, index) => summarizeElement(element, index));
  const queryElements = query
    ? visibleCandidates
        .slice(0, Math.max(maxElements, 500))
        .map((element, index) => summarizeElement(element, index))
    : elements;
  const map = pageMap();
  const forms = formSummaries();
  const layout = layoutSections(elements, forms);
  const focused = activeElementSummary();
  const modal = modalSummary();
  const bodyText = document.body ? document.body.innerText.replace(/\s+\n/g, "\n").trim() : "";
  const text = bodyText.slice(0, fullTextLimit);
  const content = mode === "text" ? contentBlocks(fullTextLimit) : undefined;
  const actionContextById = Object.fromEntries(
    elements.flatMap((element) =>
      element.context === undefined ? [] : [[element.uid, element.context] as const],
    ),
  );
  const snapshot: PageSnapshot = {
    title: document.title,
    url: location.href,
    mode: mode as SnapshotMode,
    query: query || undefined,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    summary: {
      visibleText: textOf(document.body, 500),
      visibleInteractiveCount: elements.filter((el) => el.rect.y >= 0 && el.rect.y <= innerHeight)
        .length,
      totalInteractiveSampled: elements.length,
      totalInteractiveVisible: visibleCandidates.length,
      focused: focused ? { uid: focused.uid, role: focused.role, label: focused.label } : undefined,
      modal: modal ? { uid: modal.uid, label: modal.label } : undefined,
      hints: [],
    },
    actions: elements.flatMap((element) => {
      const action = actionRefForElementSummary(element, focused?.uid);
      return action === undefined ? [] : [action];
    }),
    contexts: [],
    frontiers: [],
    actionContextById,
    ...(expansion === undefined ? {} : { observationExpansion: expansion }),
    focused: focused || undefined,
    modal: modal || undefined,
    text,
    textTruncated: content?.truncated ?? bodyText.length > text.length,
    textSnippets: visibleTextSnippets(mode === "text" ? 12000 : 3000),
    ...(content === undefined ? {} : { contentBlocks: content.blocks }),
    elements,
    forms,
    layout,
    pageMap: map,
    matches: queryMatches(query, queryElements, map),
    filter: {
      containingText: containingText || undefined,
      roleFilter: roleFilter || undefined,
      nearUid: nearUid || undefined,
    },
  };
  if (snapshot.modal)
    snapshot.summary.hints.push(
      "A modal/dialog is visible; interact with it before the underlying page.",
    );
  const disabledImportant = elements.find(
    (el) =>
      el.disabled &&
      /submit|save|merge|continue|next|send|approve|login|sign in/i.test(el.label || ""),
  );
  if (disabledImportant)
    snapshot.summary.hints.push(
      `${disabledImportant.uid} '${disabledImportant.label}' is disabled.`,
    );
  const occluded = elements.find((el) => el.occluded);
  if (occluded)
    snapshot.summary.hints.push(
      `${occluded.uid} '${occluded.label || occluded.role}' appears occluded by ${occluded.occluded!.tag}.`,
    );

  const currentDigest = digestFor(snapshot);
  snapshot.diff = diffSnapshot(state.lastSnapshotDigest, currentDigest);
  state.lastSnapshotDigest = currentDigest;

  if (mode === "interactive") {
    delete snapshot.text;
    delete snapshot.textSnippets;
    delete snapshot.pageMap;
  } else if (mode === "forms") {
    delete snapshot.text;
    delete snapshot.textSnippets;
    snapshot.elements = elements.filter((el) =>
      ["textbox", "checkbox", "radio", "combobox", "button"].includes(el.role),
    );
  } else if (mode === "pageMap") {
    delete snapshot.text;
    delete snapshot.textSnippets;
    snapshot.elements = elements.slice(0, 20);
  } else if (mode === "changes") {
    delete snapshot.text;
    delete snapshot.textSnippets;
    delete snapshot.elements;
    delete snapshot.forms;
    delete snapshot.layout;
    delete snapshot.pageMap;
  } else if (mode === "text") {
    delete snapshot.text;
    delete snapshot.textSnippets;
    delete snapshot.elements;
    delete snapshot.forms;
    delete snapshot.layout;
    delete snapshot.pageMap;
  } else if (mode !== "full") {
    snapshot.elements = elements.slice(0, Math.min(maxElements, 40));
    snapshot.text = text.slice(0, Math.min(text.length, 6000));
  }
  return snapshot;
}

export function readPage(
  maxChars: number,
  view: ReadView | null | undefined,
  query: string | null | undefined,
  observationRef: string | null | undefined,
): ReadPageResult {
  const state = getPiChromeState();
  prunePiChromeElements(state);
  let root: Document | Element = document;
  let rootUid: string | null = null;
  let offset = 0;
  let expectedFingerprint = 0;
  if (observationRef) {
    const frontier = lookupFrontier(observationRef);
    if (frontier) {
      if (frontier.projection !== "content")
        throw new Error(`Frontier ${observationRef} belongs to chrome_snapshot, not chrome_read`);
      const frontierRoot = frontier.rootUid ? lookupPiChromeElement(frontier.rootUid) : document;
      if (!frontierRoot)
        throw new Error(`Frontier ${observationRef} is stale; call chrome_read again`);
      root = frontierRoot;
      rootUid = frontier.rootUid;
      offset = frontier.offset;
      expectedFingerprint = frontier.fingerprint;
      view = frontier.view ?? view;
      query = frontier.query ?? query;
    } else {
      const context = state.refs.get(observationRef);
      if (context?.kind !== "element" || !context.context || !context.element.isConnected)
        throw new Error(`Observation ref ${observationRef} is stale or is not a readable context`);
      root = context.element;
      rootUid = observationRef;
    }
  }
  const selectedView: ReadView = view === "outline" ? "outline" : "content";
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  const projected = contentBlocks(1_000_000, root).blocks.filter((block) => {
    if (selectedView === "outline" && block.kind !== "heading") return false;
    if (!needle) return true;
    return `${block.text} ${block.links.map((link) => `${link.text} ${link.href}`).join(" ")}`
      .toLowerCase()
      .includes(needle);
  });
  const fingerprint = contentFingerprint(projected);
  if (expectedFingerprint !== 0 && expectedFingerprint !== fingerprint)
    throw new Error(`Content frontier ${observationRef} is stale; call chrome_read again`);
  const blocks = [] as typeof projected;
  let returnedCharacters = 0;
  for (const block of projected.slice(offset)) {
    const size = block.text.length + block.links.reduce((sum, link) => sum + link.text.length, 0);
    if (blocks.length > 0 && returnedCharacters + size > maxChars) break;
    blocks.push(block);
    returnedCharacters += size;
  }
  const nextOffset = offset + blocks.length;
  const truncated = nextOffset < projected.length;
  const frontiers = truncated
    ? [
        {
          kind: "frontier" as const,
          id: registerFrontier({
            projection: "content",
            rootUid,
            offset: nextOffset,
            fingerprint,
            view: selectedView,
            ...(needle ? { query: needle } : {}),
          }),
          projection: "content" as const,
          name: selectedView === "outline" ? "More outline" : "More page content",
          omittedCount: projected.length - nextOffset,
        },
      ]
    : [];
  return {
    title: document.title,
    url: location.href,
    view: selectedView,
    blocks,
    frontiers,
    coverage: {
      returnedBlocks: blocks.length,
      totalBlocks: projected.length,
      returnedCharacters,
      truncated,
    },
  };
}

export function inspectTarget(
  uid: string | null | undefined,
  selector: string | null | undefined,
  shouldScrollIntoView: boolean,
) {
  const state = getPiChromeState();
  prunePiChromeElements(state);
  let element: Element | null | undefined = null;
  if (uid) element = lookupPiChromeElement(uid);
  if (!element && selector) element = document.querySelector(selector);
  if (!element || !element.isConnected)
    throw new Error(
      uid
        ? `No live element for uid: ${uid}. Take a fresh chrome_snapshot.`
        : `No element matches selector: ${selector}`,
    );
  if (shouldScrollIntoView)
    element.scrollIntoView?.({
      block: "center",
      inline: "center",
      behavior: "instant",
    });
  const summary = summarizeElement(element, 0);
  const ancestors = [];
  let current = element.parentElement;
  while (current && current !== document.body && ancestors.length < 6) {
    ancestors.push({
      uid: rememberElement(current),
      tag: current.tagName.toLowerCase(),
      role: roleOf(current),
      label: accessibleLabel(current) || textOf(current, 100),
      selector: selectorFor(current),
    });
    current = current.parentElement;
  }
  const container = (element.closest?.(
    'form, dialog, [role="dialog"], [aria-modal="true"], section, article, main, aside',
  ) ||
    element.parentElement ||
    document.body)!;
  const nearbyText = Array.from(container.querySelectorAll("h1,h2,h3,h4,p,li,label,[role='alert']"))
    .filter(isElementVisible)
    .slice(0, 24)
    .map((node) => {
      const elementNode: Element = node;
      return {
        uid: rememberElement(elementNode),
        tag: elementNode.tagName.toLowerCase(),
        text: textOf(elementNode, 240),
        rect: rectSummary(elementNode),
      };
    })
    .filter((entry) => entry.text);
  const nearbyActions = Array.from(
    container.querySelectorAll(
      'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
    ),
  )
    .filter(isElementVisible)
    .slice(0, 30)
    .map((node, index) => summarizeElement(node, index));
  const form = element.closest?.("form");
  const formContext = form
    ? {
        uid: rememberElement(form),
        label: accessibleLabel(form) || textOf(form, 160),
        fields: Array.from(
          form.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
        )
          .filter(isElementVisible)
          .slice(0, 30)
          .map((node, index) => summarizeElement(node, index)),
        actions: Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]'))
          .filter(isElementVisible)
          .slice(0, 12)
          .map((node, index) => summarizeElement(node, index)),
      }
    : undefined;
  const rect = element.getBoundingClientRect();
  const center = {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
  };
  const clickSuggestion =
    summary.disabled || summary.inert || summary.pointerEvents === "none"
      ? undefined
      : { uid: summary.uid, x: center.x, y: center.y };
  return {
    target: summary,
    ancestors,
    nearbyText,
    nearbyActions,
    formContext,
    clickSuggestion,
  };
}
