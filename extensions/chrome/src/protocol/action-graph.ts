export const ACTION_VERBS = ["click", "fill", "press", "upload"] as const;

export type ActionVerb = (typeof ACTION_VERBS)[number];

export type ActionState = {
  readonly checked?: boolean | undefined;
  readonly focused?: true | undefined;
};

export type ActionRef = {
  readonly kind: "action";
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly state: ActionState;
  readonly verbs: ReadonlyArray<ActionVerb>;
};

export type ContextRef = {
  readonly kind: "context";
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly actionCount: number;
  readonly shownActionCount: number;
};

export type FrontierRef = {
  readonly kind: "frontier";
  readonly id: string;
  readonly projection: "actions" | "content";
  readonly name: string;
  readonly omittedCount: number;
};

export type ObservationRef = ActionRef | ContextRef | FrontierRef;

export type ActionEvidence = {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly tag?: string | undefined;
  readonly type?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly inert?: boolean | undefined;
  readonly checked?: boolean | undefined;
  readonly focused?: boolean | undefined;
  readonly editable?: boolean | undefined;
  readonly clickable?: boolean | undefined;
};

export const CLICK_ACTION_ROLES = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
] as const;

const CLICK_ROLES = new Set<string>(CLICK_ACTION_ROLES);

const EDITABLE_ROLES = new Set(["searchbox", "spinbutton", "textbox"]);

const actionVerbsFor = (evidence: ActionEvidence): ReadonlyArray<ActionVerb> => {
  if (evidence.disabled || evidence.inert) return [];
  const role = evidence.role.toLowerCase();
  const tag = evidence.tag?.toLowerCase();
  const type = evidence.type?.toLowerCase();
  if (tag === "input" && type === "file") return ["upload"];
  if (evidence.editable || EDITABLE_ROLES.has(role)) return ["fill", "press"];
  if (role === "combobox") return ["click", "press"];
  if (CLICK_ROLES.has(role) || evidence.clickable) return ["click"];
  return [];
};

export const actionRefFromEvidence = (evidence: ActionEvidence): ActionRef | undefined => {
  const verbs = actionVerbsFor(evidence);
  if (verbs.length === 0) return undefined;
  return {
    kind: "action",
    id: evidence.id,
    role: evidence.role || evidence.tag || "element",
    name: evidence.name,
    state: {
      ...(evidence.checked === undefined ? {} : { checked: evidence.checked }),
      ...(evidence.focused ? { focused: true as const } : {}),
    },
    verbs,
  };
};

export const mergeActionRefs = (
  domActions: ReadonlyArray<ActionRef>,
  accessibilityActions: ReadonlyArray<ActionRef>,
  limit: number,
): Array<ActionRef> => {
  const byId = new Map<string, ActionRef>();
  for (const action of [...domActions, ...accessibilityActions]) {
    const previous = byId.get(action.id);
    if (!previous) {
      byId.set(action.id, action);
      continue;
    }
    byId.set(action.id, {
      kind: "action",
      id: action.id,
      role: action.role || previous.role,
      name: action.name || previous.name,
      state: { ...previous.state, ...action.state },
      verbs: ACTION_VERBS.filter(
        (verb) => previous.verbs.includes(verb) || action.verbs.includes(verb),
      ),
    });
  }
  return [...byId.values()].slice(0, limit);
};
