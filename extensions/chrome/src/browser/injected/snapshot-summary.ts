import {
  accessibleLabel,
  isElementVisible,
  isSensitiveField,
  lookupPiChromeElement,
  occluderAt,
  rectSummary,
  rememberElement,
  roleOf,
  selectorFor,
  textOf,
} from "./snapshot-core.js";
import type {
  ContentBlock,
  ContentLink,
  ElementContext,
  ElementSummary,
  FormSummaries,
  LayoutItem,
  LayoutSection,
  PageMap,
  PageMapHeading,
} from "./types.js";

const CONTENT_TEXT_SELECTOR = "h1,h2,h3,h4,h5,h6,[role='heading'],p,li,dt,dd,blockquote,pre";
const CONTENT_BLOCK_SELECTOR = `${CONTENT_TEXT_SELECTOR},a[href]`;
const MAX_CONTENT_BLOCKS = 1_000;
const MAX_CONTENT_LINKS_PER_BLOCK = 8;

function directHeadingText(element: Element): string {
  const labelledBy = element.getAttribute?.("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 180);
  }
  const aria = element.getAttribute?.("aria-label");
  if (aria) return aria.trim().slice(0, 180);
  const heading = Array.from(element.querySelectorAll?.("h1,h2,h3,h4,[role='heading']") || []).find(
    isElementVisible,
  );
  if (heading) return textOf(heading, 180);
  return "";
}

function meaningfulContainerFor(element: Element): Element | null {
  let current = element.parentElement;
  let fallback = current;
  let depth = 0;
  while (current && current !== document.body && depth++ < 8) {
    if (!isElementVisible(current)) {
      current = current.parentElement;
      continue;
    }
    const tag = current.tagName.toLowerCase();
    const role = (current.getAttribute("role") || "").toLowerCase();
    const cls = typeof current.className === "string" ? current.className : "";
    const id = current.id || "";
    const named = Boolean(
      current.getAttribute("aria-label") ||
      current.getAttribute("aria-labelledby") ||
      directHeadingText(current),
    );
    const semantic =
      /^(form|dialog|section|article|nav|header|main|aside|footer|li|tr|td|fieldset)$/.test(tag) ||
      /^(dialog|alertdialog|region|group|listitem|row|cell|tabpanel|menu|toolbar|navigation|main|banner|contentinfo|complementary)$/.test(
        role,
      );
    const classHint =
      /card|panel|pane|modal|dialog|section|content|container|toolbar|menu|list|item|row|cell|header|footer|sidebar|drawer|popover|dropdown/i.test(
        `${id} ${cls}`,
      );
    const rect = current.getBoundingClientRect();
    const childActions =
      current.querySelectorAll?.(
        'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
      ).length || 0;
    if (
      (semantic || classHint || named) &&
      rect.width > 20 &&
      rect.height > 20 &&
      childActions <= 80
    )
      return current;
    if (!fallback && rect.width > 20 && rect.height > 20) fallback = current;
    current = current.parentElement;
  }
  return fallback || document.body;
}

function contextForElement(element: Element): ElementContext | undefined {
  const container = meaningfulContainerFor(element);
  if (!container || container === document.body || container === element) return undefined;
  return {
    uid: rememberElement(container),
    tag: container.tagName.toLowerCase(),
    role: roleOf(container),
    label: directHeadingText(container) || accessibleLabel(container) || textOf(container, 140),
    rect: rectSummary(container),
  };
}

function headingSummary(element: Element): PageMapHeading {
  return {
    uid: rememberElement(element),
    level:
      Number(element.tagName?.slice(1)) || Number(element.getAttribute("aria-level")) || undefined,
    text: textOf(element, 180),
  };
}

function linksForContentElement(element: Element): Array<ContentLink> {
  const links: Element[] = [];
  const enclosing = element.closest?.("a[href]");
  if (enclosing) links.push(enclosing);
  for (const link of Array.from(element.querySelectorAll?.("a[href]") || [])) links.push(link);
  const seen = new Set<string>();
  const projected: ContentLink[] = [];
  for (const link of links) {
    if (!isElementVisible(link)) continue;
    const summary = summarizeElement(link, projected.length);
    if (!summary.href || seen.has(summary.uid)) continue;
    seen.add(summary.uid);
    projected.push({
      uid: summary.uid,
      text: summary.label || textOf(link, 180),
      href: summary.href,
      ...(summary.context === undefined ? {} : { context: summary.context }),
    });
    if (projected.length >= MAX_CONTENT_LINKS_PER_BLOCK) break;
  }
  return projected;
}

export function contentBlocks(
  maxTextChars: number,
  root: Document | Element = document,
): {
  readonly blocks: Array<ContentBlock>;
  readonly truncated: boolean;
} {
  const candidates = Array.from(root.querySelectorAll(CONTENT_BLOCK_SELECTOR)).filter(
    isElementVisible,
  );
  const blocks: ContentBlock[] = [];
  let used = 0;
  let truncated = false;
  for (const element of candidates) {
    const tag = element.tagName.toLowerCase();
    if (
      tag === "a" &&
      (element.querySelector(CONTENT_TEXT_SELECTOR) !== null ||
        element.closest(CONTENT_TEXT_SELECTOR) !== null)
    ) {
      continue;
    }
    if (
      /^(li|dt|dd|blockquote)$/.test(tag) &&
      element.querySelector(CONTENT_TEXT_SELECTOR) !== null
    ) {
      continue;
    }
    const remaining = maxTextChars - used;
    if (remaining <= 0 || blocks.length >= MAX_CONTENT_BLOCKS) {
      truncated = true;
      break;
    }
    const textLimit = Math.min(2_000, remaining);
    const projectedText = textOf(element, textLimit + 1);
    const text = projectedText.slice(0, textLimit);
    if (!text) continue;
    const heading = /^(h[1-6])$/.test(tag) || roleOf(element) === "heading";
    const kind = heading
      ? "heading"
      : tag === "li"
        ? "listItem"
        : tag === "a"
          ? "link"
          : "paragraph";
    const context = contextForElement(element);
    const level = heading ? headingSummary(element).level : undefined;
    const block: ContentBlock = {
      kind,
      uid: rememberElement(element),
      text,
      ...(level === undefined ? {} : { level }),
      ...(context === undefined ? {} : { context }),
      links: linksForContentElement(element),
    };
    blocks.push(block);
    used += text.length;
    if (projectedText.length > text.length) truncated = true;
  }
  return { blocks, truncated };
}

export function summarizeElement(element: Element, index: number): ElementSummary {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const occluded = occluderAt(cx, cy, element);
  const role = roleOf(element);
  const disabled = Boolean(
    (element as Element & { disabled?: unknown }).disabled ||
    element.getAttribute("aria-disabled") === "true",
  );
  const rawValue =
    "value" in element && typeof element.value === "string" ? element.value : undefined;
  const sensitive = isSensitiveField(element);
  const value = rawValue && !sensitive ? rawValue.slice(0, 120) : undefined;
  const checked = "checked" in element ? Boolean(element.checked) : undefined;
  return {
    index,
    uid: rememberElement(element),
    tag: element.tagName.toLowerCase(),
    role,
    selector: selectorFor(element),
    label: accessibleLabel(element),
    href: (element as Element & { href?: string }).href || undefined,
    type: element.getAttribute("type") || undefined,
    value: value || undefined,
    hasValue: rawValue ? rawValue.length > 0 : undefined,
    valueLength: rawValue && sensitive ? rawValue.length : undefined,
    valueRedacted: sensitive && rawValue ? true : undefined,
    checked,
    disabled,
    inert: Boolean(element.closest?.("[inert]")),
    pointerEvents: style.pointerEvents,
    occluded: occluded || undefined,
    context: contextForElement(element),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

export function isInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
}

export function formSummaries(): FormSummaries {
  const fields = Array.from(
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]'),
  )
    .filter(isElementVisible)
    .slice(0, 80)
    .map((element, index) => ({
      ...summarizeElement(element, index),
      required: Boolean(
        (element as HTMLInputElement).required || element.getAttribute("aria-required") === "true",
      ),
      invalid: Boolean(
        element.matches?.(":invalid") || element.getAttribute("aria-invalid") === "true",
      ),
      autocomplete: element.getAttribute("autocomplete") || undefined,
    }));
  const submits = Array.from(
    document.querySelectorAll('button, input[type="submit"], [role="button"]'),
  )
    .filter(isElementVisible)
    .filter((element) =>
      /submit|save|continue|next|send|sign in|log in|create|update|done/i.test(
        accessibleLabel(element) + " " + (element.getAttribute("type") || ""),
      ),
    )
    .slice(0, 30)
    .map((element, index) => summarizeElement(element, index));
  return { fields, submits };
}

export function pageMap(): PageMap {
  const landmarkSelectors: ReadonlyArray<readonly [string, string]> = [
    ["header", 'header, [role="banner"]'],
    ["nav", 'nav, [role="navigation"]'],
    ["main", 'main, [role="main"]'],
    ["aside", 'aside, [role="complementary"]'],
    ["footer", 'footer, [role="contentinfo"]'],
    ["dialog", 'dialog, [role="dialog"], [aria-modal="true"]'],
    ["form", "form"],
  ];
  const regions: PageMap["regions"] = [];
  for (const [kind, selector] of landmarkSelectors) {
    for (const element of Array.from(document.querySelectorAll(selector))
      .filter(isElementVisible)
      .slice(0, 12)) {
      const headings = Array.from(element.querySelectorAll("h1,h2,h3,[role='heading']"))
        .filter(isElementVisible)
        .slice(0, 6)
        .map((h) => textOf(h, 120));
      const actions = Array.from(
        element.querySelectorAll(
          'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])',
        ),
      )
        .filter(isElementVisible)
        .slice(0, 8)
        .map((a) => {
          const summary = summarizeElement(a, 0);
          return {
            uid: summary.uid,
            role: summary.role,
            label: summary.label || summary.selector,
            disabled: summary.disabled || undefined,
          };
        });
      regions.push({
        kind,
        uid: rememberElement(element),
        label: accessibleLabel(element) || headings[0] || textOf(element, 100),
        headings,
        actions,
      });
    }
  }
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role='heading']"))
    .filter(isElementVisible)
    .slice(0, 30)
    .map(headingSummary);
  return { regions, headings };
}

export function layoutSections(
  elements: ReadonlyArray<ElementSummary>,
  forms: FormSummaries,
): Array<LayoutSection> {
  const byUid = new Map<string, LayoutSection>();
  const addToSection = (summary: ElementSummary, kind: "field" | "action"): void => {
    const source = lookupPiChromeElement(summary.uid);
    const container = source ? meaningfulContainerFor(source) : null;
    if (!container || container === document.body) return;
    const uid = rememberElement(container);
    let section = byUid.get(uid);
    if (!section) {
      const rect = rectSummary(container);
      section = {
        uid,
        tag: container.tagName.toLowerCase(),
        role: roleOf(container),
        label: directHeadingText(container) || accessibleLabel(container) || textOf(container, 160),
        text: textOf(container, 260),
        rect,
        actions: [],
        fields: [],
      };
      byUid.set(uid, section);
    }
    const item: LayoutItem = {
      uid: summary.uid,
      role: summary.role,
      label: summary.label || summary.selector,
      disabled: summary.disabled || undefined,
    };
    if (kind === "field") section.fields.push(item);
    else section.actions.push(item);
  };
  for (const el of (elements || []).slice(0, 80))
    addToSection(
      el,
      ["textbox", "checkbox", "radio", "combobox"].includes(el.role) ? "field" : "action",
    );
  for (const field of (forms?.fields || []).slice(0, 80)) addToSection(field, "field");
  const sections = Array.from(byUid.values())
    .filter((section) => section.actions.length || section.fields.length)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .slice(0, 18);
  for (const section of sections) {
    section.actions = section.actions.slice(0, 10);
    section.fields = section.fields.slice(0, 10);
  }
  return sections;
}
