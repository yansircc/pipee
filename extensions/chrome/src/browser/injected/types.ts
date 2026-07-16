import type { ActionRef, ContextRef, FrontierRef } from "../../protocol/action-graph.js";

const SNAPSHOT_MODES = [
  "auto",
  "interactive",
  "forms",
  "pageMap",
  "text",
  "changes",
  "full",
] as const;

export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];

export type EditableValueElement = HTMLElement & {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

export type RectSummary = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OccluderSummary = {
  tag: string;
  id?: string | undefined;
  className?: string | undefined;
};

export type ElementContext = {
  uid: string;
  tag: string;
  role: string;
  label: string;
  rect: RectSummary;
};

export type ElementSummary = {
  index: number;
  uid: string;
  tag: string;
  role: string;
  selector: string;
  label: string;
  href?: string | undefined;
  type?: string | undefined;
  value?: string | undefined;
  hasValue?: boolean | undefined;
  valueLength?: number | undefined;
  valueRedacted?: boolean | undefined;
  checked?: boolean | undefined;
  disabled: boolean;
  inert: boolean;
  pointerEvents: string;
  occluded?: OccluderSummary | undefined;
  context?: ElementContext | undefined;
  rect: RectSummary;
};

export type FormFieldSummary = ElementSummary & {
  required: boolean;
  invalid: boolean;
  autocomplete?: string | undefined;
};

export type FormSummaries = {
  fields: Array<FormFieldSummary>;
  submits: Array<ElementSummary>;
};

export type PageMapAction = {
  uid: string;
  role: string;
  label: string;
  disabled?: boolean | undefined;
};

export type PageMapRegion = {
  kind: string;
  uid: string;
  label: string;
  headings: Array<string>;
  actions: Array<PageMapAction>;
};

export type PageMapHeading = {
  uid: string;
  level?: number | undefined;
  text: string;
};

export type PageMap = {
  regions: Array<PageMapRegion>;
  headings: Array<PageMapHeading>;
};

export type LayoutItem = {
  uid: string;
  role: string;
  label: string;
  disabled?: boolean | undefined;
};

export type LayoutSection = {
  uid: string;
  tag: string;
  role: string;
  label: string;
  text: string;
  rect: RectSummary;
  actions: Array<LayoutItem>;
  fields: Array<LayoutItem>;
};

export type ModalSummary = {
  uid: string;
  tag: string;
  role: string;
  label: string;
  rect: RectSummary;
};

export type TextSnippet = {
  uid: string;
  tag: string;
  text: string;
  rect: RectSummary;
};

export type ContentLink = {
  uid: string;
  text: string;
  href: string;
  context?: ElementContext | undefined;
};

export type ContentBlock = {
  kind: "heading" | "paragraph" | "listItem" | "link";
  uid: string;
  text: string;
  level?: number | undefined;
  context?: ElementContext | undefined;
  links: Array<ContentLink>;
};

export type ReadView = "content" | "outline";

export type ReadPageResult = {
  readonly title: string;
  readonly url: string;
  readonly view: ReadView;
  readonly blocks: Array<ContentBlock>;
  readonly frontiers: Array<FrontierRef>;
  readonly coverage: {
    readonly returnedBlocks: number;
    readonly totalBlocks: number;
    readonly returnedCharacters: number;
    readonly truncated: boolean;
  };
};

export type ElementQueryMatch = ElementSummary & {
  score: number;
  kind: "element";
};

export type TextQueryMatch = TextSnippet & {
  score: number;
  kind: "text";
  role: string;
};

export type RegionQueryMatch = PageMapRegion & {
  score: number;
};

export type QueryMatch = ElementQueryMatch | TextQueryMatch | RegionQueryMatch;

export type SnapshotChange =
  | { kind: "url" | "title" | "focus" | "modal"; before: string | null; after: string | null }
  | { kind: "textChanged" };

export type SnapshotUpdatedLabel = {
  uid: string;
  before: PiChromeSnapshotDigestLabel;
  after: PiChromeSnapshotDigestLabel;
};

export type SnapshotDiff =
  | { firstSnapshot: true }
  | {
      changes: Array<SnapshotChange>;
      added: Array<PiChromeSnapshotDigestLabel>;
      removed: Array<PiChromeSnapshotDigestLabel>;
      updated: Array<SnapshotUpdatedLabel>;
    };

export type PageSnapshot = {
  title: string;
  url: string;
  mode: SnapshotMode;
  query?: string | undefined;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
  };
  summary: {
    visibleText: string;
    visibleInteractiveCount: number;
    totalInteractiveSampled: number;
    totalInteractiveVisible: number;
    focused?: Pick<ElementSummary, "uid" | "role" | "label"> | undefined;
    modal?: Pick<ModalSummary, "uid" | "label"> | undefined;
    hints: Array<string>;
  };
  actions: Array<ActionRef>;
  contexts: Array<ContextRef>;
  frontiers: Array<FrontierRef>;
  actionContextById?: Readonly<Record<string, ElementContext>> | undefined;
  observationExpansion?:
    | {
        rootUid: string | null;
        offset: number;
        fingerprint: number;
      }
    | undefined;
  focused?: ElementSummary | undefined;
  modal?: ModalSummary | undefined;
  text?: string | undefined;
  textTruncated: boolean;
  textSnippets?: Array<TextSnippet> | undefined;
  contentBlocks?: Array<ContentBlock> | undefined;
  elements?: Array<ElementSummary> | undefined;
  forms?: FormSummaries | undefined;
  layout?: Array<LayoutSection> | undefined;
  pageMap?: PageMap | undefined;
  matches: Array<QueryMatch>;
  filter: {
    containingText?: string | undefined;
    roleFilter?: string | undefined;
    nearUid?: string | undefined;
  };
  diff?: SnapshotDiff | undefined;
};

export type ResolvedPoint = {
  element: Element | null;
  x: number;
  y: number;
  rect?: DOMRect | undefined;
};
