import {
  accessibleLabel,
  hashString,
  isElementVisible,
  rectSummary,
  rememberElement,
  roleOf,
  textOf,
} from "./snapshot-core.js";
import { isInViewport, summarizeElement } from "./snapshot-summary.js";
import type {
  ElementSummary,
  ModalSummary,
  PageMap,
  PageSnapshot,
  QueryMatch,
  SnapshotChange,
  SnapshotDiff,
  TextQueryMatch,
  TextSnippet,
} from "./types.js";

function tokenScore(haystack: string, query: string): number {
  if (!query) return 0;
  const hay = String(haystack || "").toLowerCase();
  const tokens = String(query).toLowerCase().split(/\W+/).filter(Boolean);
  if (!tokens.length) return 0;
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += token.length <= 2 ? 1 : 3;
  }
  if (hay.includes(String(query).toLowerCase())) score += 8;
  return score;
}

export function queryMatches(
  query: string | null | undefined,
  elements: ReadonlyArray<ElementSummary>,
  map: PageMap,
): Array<QueryMatch> {
  if (!query) return [];
  const candidates: Array<QueryMatch> = [];
  for (const element of elements) {
    const hay = [element.role, element.label, element.selector, element.type, element.href]
      .filter(Boolean)
      .join(" ");
    const score = tokenScore(hay, query);
    if (score > 0) candidates.push({ score, kind: "element", ...element });
  }
  const textNodes: Array<TextQueryMatch> = [];
  for (const block of Array.from(
    document.querySelectorAll("h1,h2,h3,h4,p,li,td,th,label,summary,[role='alert']"),
  )
    .filter(isElementVisible)
    .slice(0, 300)) {
    const text = textOf(block, 300);
    const score = tokenScore(text, query);
    if (score > 0)
      textNodes.push({
        score,
        kind: "text",
        uid: rememberElement(block),
        tag: block.tagName.toLowerCase(),
        role: roleOf(block),
        text,
        rect: rectSummary(block),
      });
  }
  for (const region of map.regions || []) {
    const score = tokenScore(
      [region.kind, region.label, ...(region.headings || [])].join(" "),
      query,
    );
    if (score > 0)
      candidates.push({ score, kind: "region", ...(region as Omit<typeof region, "kind">) });
  }
  return candidates
    .concat(textNodes)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export function activeElementSummary(): ElementSummary | null {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return summarizeElement(el, 0);
}

export function modalSummary(): ModalSummary | null {
  const selectors = 'dialog[open], [role="dialog"], [aria-modal="true"], [role="alertdialog"]';
  const modal = Array.from(document.querySelectorAll(selectors)).find(isElementVisible);
  if (!modal) return null;
  return {
    uid: rememberElement(modal),
    tag: modal.tagName.toLowerCase(),
    role: roleOf(modal),
    label: accessibleLabel(modal) || textOf(modal, 180),
    rect: rectSummary(modal),
  };
}

export function digestFor(snapshot: PageSnapshot): PiChromeSnapshotDigest {
  return {
    url: snapshot.url,
    title: snapshot.title,
    textHash: hashString(snapshot.text || ""),
    focusedUid: snapshot.focused?.uid || null,
    modalUid: snapshot.modal?.uid || null,
    labels: (snapshot.elements || []).slice(0, 50).map((el) => ({
      uid: el.uid,
      role: el.role,
      label: el.label,
      disabled: el.disabled,
      value: el.value,
      checked: el.checked,
    })),
  };
}

export function diffSnapshot(
  previous: PiChromeSnapshotDigest | null | undefined,
  current: PiChromeSnapshotDigest,
): SnapshotDiff {
  if (!previous) return { firstSnapshot: true };
  const changes: Array<SnapshotChange> = [];
  if (previous.url !== current.url)
    changes.push({ kind: "url", before: previous.url, after: current.url });
  if (previous.title !== current.title)
    changes.push({
      kind: "title",
      before: previous.title,
      after: current.title,
    });
  if (previous.textHash !== current.textHash) changes.push({ kind: "textChanged" });
  if (previous.focusedUid !== current.focusedUid)
    changes.push({
      kind: "focus",
      before: previous.focusedUid,
      after: current.focusedUid,
    });
  if (previous.modalUid !== current.modalUid)
    changes.push({
      kind: "modal",
      before: previous.modalUid,
      after: current.modalUid,
    });
  const prevByUid = new Map<string, PiChromeSnapshotDigestLabel>(
    (previous.labels || []).map((x) => [x.uid, x]),
  );
  const curByUid = new Map<string, PiChromeSnapshotDigestLabel>(
    (current.labels || []).map((x) => [x.uid, x]),
  );
  const added: Array<PiChromeSnapshotDigestLabel> = [];
  const removed: Array<PiChromeSnapshotDigestLabel> = [];
  const updated: Array<{
    uid: string;
    before: PiChromeSnapshotDigestLabel;
    after: PiChromeSnapshotDigestLabel;
  }> = [];
  for (const cur of current.labels || []) {
    const prev = prevByUid.get(cur.uid);
    if (!prev) added.push(cur);
    else if (
      prev.label !== cur.label ||
      prev.disabled !== cur.disabled ||
      prev.value !== cur.value ||
      prev.checked !== cur.checked
    )
      updated.push({ uid: cur.uid, before: prev, after: cur });
  }
  for (const prev of previous.labels || []) {
    if (!curByUid.has(prev.uid)) removed.push(prev);
  }
  return {
    changes,
    added: added.slice(0, 12),
    removed: removed.slice(0, 12),
    updated: updated.slice(0, 12),
  };
}

export function visibleTextSnippets(maxChars: number): Array<TextSnippet> {
  const snippets: Array<TextSnippet> = [];
  const blocks = Array.from(
    document.querySelectorAll("h1,h2,h3,h4,p,li,td,th,label,summary,[role='alert']"),
  ).filter(isElementVisible);
  let used = 0;
  for (const block of blocks) {
    if (!isInViewport(block) && snippets.length > 12) continue;
    const text = textOf(block, 500);
    if (!text || snippets.some((s) => s.text === text)) continue;
    const next = {
      uid: rememberElement(block),
      tag: block.tagName.toLowerCase(),
      text,
      rect: rectSummary(block),
    };
    snippets.push(next);
    used += text.length;
    if (used >= maxChars || snippets.length >= 40) break;
  }
  return snippets;
}
