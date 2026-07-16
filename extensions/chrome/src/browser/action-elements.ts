import {
  actionRefFromEvidence,
  CLICK_ACTION_ROLES,
  type ActionRef,
} from "../protocol/action-graph.js";
import type { ElementSummary } from "./injected/types.js";

export const ACTION_ELEMENT_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  ...CLICK_ACTION_ROLES.map((role) => `[role='${role}']`),
  "[contenteditable='true']",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export const ACTION_BLOCKED_SELECTOR = ":disabled,[disabled],[aria-disabled='true'],[inert]";

export const actionRefForElementSummary = (
  element: ElementSummary,
  focusedUid: string | undefined,
): ActionRef | undefined => {
  if (element.occluded || element.pointerEvents === "none") return undefined;
  return actionRefFromEvidence({
    id: element.uid,
    role: element.role,
    name: element.label,
    tag: element.tag,
    type: element.type,
    disabled: element.disabled,
    inert: element.inert,
    checked: element.checked,
    focused: element.uid === focusedUid,
    editable: element.role === "textbox" || element.tag === "textarea",
    clickable: true,
  });
};
