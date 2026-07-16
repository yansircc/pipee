import {
  getPiChromeState,
  isElementVisible,
  lookupFrontier,
  lookupPiChromeElement,
  occluderAt,
  prunePiChromeElements,
  registerFrontier,
  rememberElement,
} from "./action-core.js";
import { installPiChromeInstrumentation } from "./action-instrumentation.js";

export {
  getPiChromeState,
  installPiChromeInstrumentation,
  isElementVisible,
  lookupFrontier,
  lookupPiChromeElement,
  occluderAt,
  prunePiChromeElements,
  registerFrontier,
  rememberElement,
};

export function textOf(element: Element | null | undefined, max?: number): string {
  return (
    (element as (Element & { innerText?: string }) | null | undefined)?.innerText ||
    element?.textContent ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max || 500);
}

export function accessibleLabel(element: Element | null | undefined): string {
  if (!element) return "";
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const id = element.id;
  if (id) {
    try {
      const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      if ((label as HTMLElement | null)?.innerText) return (label as HTMLElement).innerText;
    } catch {}
  }
  const wrappingLabel = element.closest?.("label");
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    wrappingLabel?.innerText ||
    (element as Element & { innerText?: string }).innerText ||
    element.textContent ||
    ""
  )
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function cssEscape(value: string): string {
  return window.CSS && CSS.escape
    ? CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

export function roleOf(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.toLowerCase();
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (tag === "a" && (element as Element & { href?: string }).href) return "link";
  if (tag === "button" || type === "button" || type === "submit" || type === "reset")
    return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    if (
      [
        "checkbox",
        "radio",
        "range",
        "search",
        "email",
        "password",
        "tel",
        "url",
        "number",
      ].includes(type)
    )
      return type === "checkbox" || type === "radio" || type === "range" ? type : "textbox";
    return "textbox";
  }
  if ((element as Element & { isContentEditable?: boolean }).isContentEditable) return "textbox";
  if (tag.match(/^h[1-6]$/)) return "heading";
  return tag;
}

export function isSensitiveField(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = element.tagName?.toLowerCase?.() || "";
  if (
    !/^(input|textarea|select)$/.test(tag) &&
    !(element as Element & { isContentEditable?: boolean }).isContentEditable
  )
    return false;
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (["password"].includes(type)) return true;
  const haystack = [
    type,
    element.getAttribute("name"),
    element.id,
    element.getAttribute("autocomplete"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("data-testid"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /password|passwd|\bpwd\b|secret|token|bearer|api[-_ ]?key|access[-_ ]?key|auth[-_ ]?code|one[-_ ]?time|otp|2fa|mfa|verification[-_ ]?code|recovery[-_ ]?code|credit[-_ ]?card|card[-_ ]?number|cc-number|cc-csc|cvc|cvv|security[-_ ]?code|ssn|social[-_ ]?security/.test(
    haystack,
  );
}

export function hashString(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

export function selectorFor(element: Element): string {
  const unique = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  if (element.id && unique("#" + cssEscape(element.id))) return "#" + cssEscape(element.id);
  const attr = ["aria-label", "name", "placeholder", "data-testid", "role"].find((name) =>
    element.getAttribute(name),
  );
  if (attr) {
    const candidate =
      element.tagName.toLowerCase() +
      "[" +
      attr +
      "=" +
      JSON.stringify(element.getAttribute(attr)) +
      "]";
    if (unique(candidate)) return candidate;
  }
  const parts = [];
  let current: Element | null = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    if (current.classList.length > 0)
      part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".");
    const siblings = (Array.from(current.parentElement?.children ?? []) as Array<Element>).filter(
      (sibling) => sibling.tagName === current!.tagName,
    );
    if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
    parts.unshift(part);
    const candidate = parts.join(" > ");
    if (unique(candidate)) return candidate;
    current = current.parentElement;
  }
  return parts.join(" > ");
}

export function rectSummary(element: Element): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
