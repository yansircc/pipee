import type { InputCall } from "../protocol/schema.js";
import type { ResolvedTab } from "./platform-targets.js";

type InputOperation = InputCall["operation"];
type Operation<Kind extends InputOperation["kind"]> = Extract<
  InputOperation,
  { readonly kind: Kind }
>;

export type BrowserInputContext = {
  readonly tab: ResolvedTab;
  readonly foreground: boolean;
};

export type ElementLocator = {
  readonly selector?: string | null | undefined;
  readonly uid?: string | null | undefined;
};

export type PointLocator = ElementLocator & {
  readonly x?: number | null | undefined;
  readonly y?: number | null | undefined;
};

export type CdpModifierState = {
  readonly shiftKey?: boolean | undefined;
  readonly ctrlKey?: boolean | undefined;
  readonly altKey?: boolean | undefined;
  readonly metaKey?: boolean | undefined;
};

export type ChromeInputClickParams = BrowserInputContext &
  Omit<Operation<"click">, "kind" | "at"> &
  PointLocator;
export type ChromeInputHoverParams = BrowserInputContext &
  Omit<Operation<"hover">, "kind" | "at"> &
  PointLocator;
export type ChromeInputTapParams = BrowserInputContext &
  Omit<Operation<"tap">, "kind" | "at"> &
  PointLocator;
export type ChromeInputTypeParams = BrowserInputContext &
  Omit<Operation<"type">, "kind" | "into"> &
  ElementLocator;
export type ChromeInputFillParams = BrowserInputContext &
  Omit<Operation<"fill">, "kind" | "into"> &
  ElementLocator;
export type ChromeInputUploadParams = BrowserInputContext &
  Omit<Operation<"upload">, "kind" | "into"> &
  ElementLocator;
export type ChromeInputScrollParams = BrowserInputContext &
  Omit<Operation<"scroll">, "kind" | "within"> &
  ElementLocator;
export type ChromeInputKeyParams = BrowserInputContext &
  Omit<Operation<"key">, "kind" | "at" | "modifiers"> &
  ElementLocator & {
    readonly modifiers?: CdpModifierState | undefined;
  };
export type ChromeInputDragParams = BrowserInputContext &
  Omit<Operation<"drag">, "kind" | "from" | "to"> & {
    readonly fromUid?: string | undefined;
    readonly fromSelector?: string | undefined;
    readonly fromX?: number | undefined;
    readonly fromY?: number | undefined;
    readonly toUid?: string | undefined;
    readonly toSelector?: string | undefined;
    readonly toX?: number | undefined;
    readonly toY?: number | undefined;
  };

export type InputPoint = { readonly x: number; readonly y: number };
export type InputRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type ResolvedInputTarget = InputPoint & {
  readonly found: true;
  readonly rect: InputRect | null;
  readonly tag: string | null;
  readonly requestedTag?: string | undefined;
  readonly promotedFromTag?: string | undefined;
  readonly resolvedUid?: string | undefined;
  readonly interactive?: true | undefined;
  readonly staleUid?: never;
  readonly nonInteractive?: never;
  readonly invalidClickTarget?: never;
  readonly reason?: never;
};

export type FailedInputTarget = {
  readonly found: false;
  readonly staleUid?: true | undefined;
  readonly verbMismatch?: true | undefined;
  readonly nonInteractive?: true | undefined;
  readonly invalidClickTarget?: true | undefined;
  readonly reason?: string | undefined;
  readonly url?: string | undefined;
};

export type InputTargetResolution = ResolvedInputTarget | FailedInputTarget;

export type ClickState = {
  readonly url: string;
  readonly title: string;
  readonly status: string;
  readonly focus: string;
  readonly scroll: string;
  readonly pageHash: number | undefined;
};

export type ClickObservedChange =
  | "url"
  | "navigation-pending"
  | "title"
  | "focus"
  | "scroll"
  | "page";

export type ClickOutcome = {
  readonly outcome: "effect-observed" | "input-dispatched-no-observable-effect";
  readonly observedChanges: Array<ClickObservedChange>;
  readonly urlChanged: boolean;
  readonly titleChanged: boolean;
  readonly focusChanged: boolean;
  readonly scrollChanged: boolean;
  readonly pageChanged: boolean;
  readonly urlBefore: string;
  readonly urlAfter: string;
};

export type ClickDispatchResult = InputPoint & {
  readonly input: "chrome";
  readonly tag: string | null;
  readonly requestedTag?: string | undefined;
  readonly promotedFromTag?: string | undefined;
  readonly resolvedUid?: string | undefined;
};

export type ChromeInputClickResult = ClickDispatchResult &
  ClickOutcome & { readonly observedAfterMs: number };
export type ChromeInputHoverResult = InputPoint & {
  readonly input: "chrome";
  readonly tag: string | null;
};
export type ChromeInputKeyResult = {
  readonly input: "chrome";
  readonly key: string;
  readonly modifiers: CdpModifierState;
};
export type ChromeInputTextResult = { readonly input: "chrome"; readonly length: number };
export type ChromeInputScrollResult = {
  readonly input: "chrome";
  readonly deltaX: number;
  readonly deltaY: number;
  readonly steps: number;
};
export type ChromeInputTapResult = ChromeInputHoverResult;
export type ChromeInputDragResult = {
  readonly input: "chrome";
  readonly from: InputPoint;
  readonly to: InputPoint;
  readonly steps: number;
};
export type ChromeInputUploadResult = {
  readonly input: "chrome";
  readonly uploaded: Array<{ readonly path: string }>;
};

export type KeyLayoutInfo = {
  readonly code: string;
  readonly keyCode: number;
  readonly needShift: boolean;
};

export type CdpKeyInfo = {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text: string;
};
