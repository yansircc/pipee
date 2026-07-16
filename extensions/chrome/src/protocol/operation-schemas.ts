import * as Schema from "effect/Schema";
import {
  AUTOMATION_TARGET_LIMITS,
  SCREENSHOT_LIMITS,
  SCREENSHOT_MAX_TILE_COUNT,
} from "./bridge-contract.js";
import { isCompleteFullPageTileSet } from "./screenshot-geometry.js";

const optional = Schema.optionalKey;
const NonBlankString = Schema.String.check(Schema.isPattern(/\S/));
const FiniteNumber = Schema.Finite;
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OperationTimeoutMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 }));
const WaitIntervalMs = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }));
const InputSteps = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 }));
const ScrollSteps = Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 40 }));
const InputText = Schema.String.check(Schema.isMaxLength(500));
const JpegQuality = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const UPLOAD_LIMITS = { maxPaths: 32, maxPathLength: 4_096 } as const;
const UploadPath = NonBlankString.check(Schema.isMaxLength(UPLOAD_LIMITS.maxPathLength));
const UploadPaths = Schema.Array(UploadPath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(UPLOAD_LIMITS.maxPaths),
);

const WorkspaceRelativePath = Schema.String.check(
  Schema.isPattern(
    /^(?!\/)(?![A-Za-z]:[\\/])(?!.*\\)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?=.*\S).+$/,
  ),
  Schema.makeFilter((value: string) =>
    value.includes("\0") ? "Workspace-relative paths cannot contain a null byte" : undefined,
  ),
).annotate({
  description:
    "Portable workspace-relative path using slash-separated segments; absolute, dot, parent, backslash, and null-byte segments are forbidden.",
});

export const Target = Schema.Union([
  Schema.Struct({ by: Schema.Literal("id"), value: NonNegativeInt }),
  Schema.Struct({ by: Schema.Literal("url"), value: NonBlankString }),
  Schema.Struct({ by: Schema.Literal("title"), value: NonBlankString }),
]).annotate({ description: "Exactly one Chrome tab selector." });

export const ElementTarget = Schema.Union([
  Schema.Struct({ by: Schema.Literal("uid"), value: NonBlankString }),
  Schema.Struct({ by: Schema.Literal("selector"), value: NonBlankString }),
]);

export const PointerTarget = Schema.Union([
  ElementTarget,
  Schema.Struct({
    by: Schema.Literal("coordinate"),
    x: FiniteNumber,
    y: FiniteNumber,
  }),
]);

const GroupColor = Schema.Literals([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
]);

const SnapshotMode = Schema.Literals([
  "auto",
  "interactive",
  "forms",
  "pageMap",
  "text",
  "changes",
  "full",
]);

const SnapshotElementLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 80 }));
const SnapshotTextLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }));
const ReadTextLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24_000 }));
const ObservationRefId = Schema.String.check(Schema.isPattern(/^@?(?:el|frontier)-\d+$/)).annotate({
  description: "A fresh context or frontier ref returned by page observation.",
});
const Modifiers = Schema.Struct({
  shift: optional(Schema.Boolean),
  control: optional(Schema.Boolean),
  alt: optional(Schema.Boolean),
  meta: optional(Schema.Boolean),
});
const SnapshotVerification = {
  includeSnapshot: optional(Schema.Boolean),
  maxElements: optional(SnapshotElementLimit),
};

const SnapshotFields = {
  ref: optional(ObservationRefId),
  mode: optional(SnapshotMode),
  query: optional(Schema.String),
  maxElements: optional(SnapshotElementLimit),
  maxTextChars: optional(SnapshotTextLimit),
  containingText: optional(Schema.String),
  role: optional(Schema.String),
  nearUid: optional(Schema.String),
};

const SnapshotOptions = Schema.Struct(SnapshotFields);

const ScreenshotCapture = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("viewport") }),
  Schema.Struct({ kind: Schema.Literal("full-page-tiles") }),
]);

const ToolScreenshotCapture = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("viewport"),
    path: optional(WorkspaceRelativePath),
  }),
  Schema.Struct({
    kind: Schema.Literal("full-page-tiles"),
    directory: optional(WorkspaceRelativePath),
  }),
]);

const screenshotCall = <Capture extends Schema.ConstraintDecoder<unknown>>(capture: Capture) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("screenshot"),
      capture,
      format: Schema.Literal("png"),
      quality: optional(Schema.Never),
    }),
    Schema.Struct({
      kind: Schema.Literal("screenshot"),
      capture,
      format: Schema.Literal("jpeg"),
      quality: optional(JpegQuality),
    }),
  ]);

const ScreenshotCall = screenshotCall(ScreenshotCapture);
export const ToolScreenshotCall = screenshotCall(ToolScreenshotCapture);

export const TabCalls = {
  list: Schema.Struct({ op: Schema.Literal("list") }),
  new: Schema.Struct({
    op: Schema.Literal("new"),
    url: optional(NonBlankString),
    groupColor: optional(GroupColor),
  }),
  activate: Schema.Struct({ op: Schema.Literal("activate"), target: optional(Target) }),
  close: Schema.Struct({ op: Schema.Literal("close"), target: optional(Target) }),
  group: Schema.Struct({
    op: Schema.Literal("group"),
    target: optional(Target),
    groupColor: optional(GroupColor),
  }),
  ungroup: Schema.Struct({ op: Schema.Literal("ungroup"), target: optional(Target) }),
} as const;

export const PageCalls = {
  snapshot: Schema.Struct({
    kind: Schema.Literal("snapshot"),
    ...SnapshotFields,
  }),
  read: Schema.Struct({
    kind: Schema.Literal("read"),
    ref: optional(ObservationRefId),
    view: optional(Schema.Literals(["content", "outline"])),
    query: optional(Schema.String),
    maxChars: optional(ReadTextLimit),
  }),
  inspect: Schema.Struct({
    kind: Schema.Literal("inspect"),
    element: ElementTarget,
    scrollIntoView: optional(Schema.Boolean),
  }),
  navigate: Schema.Struct({
    kind: Schema.Literal("navigate"),
    url: NonBlankString,
    waitUntilLoad: optional(Schema.Boolean),
    timeoutMs: optional(OperationTimeoutMs),
    initScript: optional(Schema.String),
    snapshot: optional(SnapshotOptions),
  }),
  evaluate: Schema.Struct({
    kind: Schema.Literal("evaluate"),
    expression: NonBlankString,
    awaitPromise: optional(Schema.Boolean),
  }),
  wait: Schema.Struct({
    kind: Schema.Literal("wait"),
    condition: Schema.Union([
      Schema.Struct({ by: Schema.Literal("selector"), value: NonBlankString }),
      Schema.Struct({ by: Schema.Literal("urlIncludes"), value: NonBlankString }),
      Schema.Struct({ by: Schema.Literal("textContains"), value: NonBlankString }),
      Schema.Struct({ by: Schema.Literal("expression"), value: NonBlankString }),
    ]),
    timeoutMs: optional(OperationTimeoutMs),
    intervalMs: optional(WaitIntervalMs),
  }),
  console: Schema.Struct({ kind: Schema.Literal("console"), clear: optional(Schema.Boolean) }),
  "network-list": Schema.Struct({
    kind: Schema.Literal("network-list"),
    includePreserved: optional(Schema.Boolean),
    clear: optional(Schema.Boolean),
  }),
  "network-get": Schema.Struct({
    kind: Schema.Literal("network-get"),
    requestId: NonBlankString,
  }),
  screenshot: ScreenshotCall,
} as const;

export const InputCalls = {
  click: Schema.Struct({
    kind: Schema.Literal("click"),
    at: PointerTarget,
    ...SnapshotVerification,
  }),
  type: Schema.Struct({
    kind: Schema.Literal("type"),
    text: InputText,
    into: optional(ElementTarget),
    pressEnter: optional(Schema.Boolean),
    ...SnapshotVerification,
  }),
  fill: Schema.Struct({
    kind: Schema.Literal("fill"),
    text: InputText,
    into: ElementTarget,
    submit: optional(Schema.Boolean),
    ...SnapshotVerification,
  }),
  key: Schema.Struct({
    kind: Schema.Literal("key"),
    key: NonBlankString,
    at: optional(ElementTarget),
    modifiers: optional(Modifiers),
    ...SnapshotVerification,
  }),
  hover: Schema.Struct({ kind: Schema.Literal("hover"), at: PointerTarget }),
  drag: Schema.Struct({
    kind: Schema.Literal("drag"),
    from: PointerTarget,
    to: PointerTarget,
    steps: optional(InputSteps),
  }),
  tap: Schema.Struct({ kind: Schema.Literal("tap"), at: PointerTarget }),
  scroll: Schema.Struct({
    kind: Schema.Literal("scroll"),
    within: optional(ElementTarget),
    deltaY: optional(FiniteNumber),
    deltaX: optional(FiniteNumber),
    steps: optional(ScrollSteps),
  }),
  upload: Schema.Struct({
    kind: Schema.Literal("upload"),
    into: ElementTarget,
    paths: UploadPaths,
  }),
} as const;

export const SystemCalls = {
  version: Schema.Struct({ op: Schema.Literal("version") }),
  "automation-status": Schema.Struct({ op: Schema.Literal("automation-status") }),
  cleanup: Schema.Struct({ op: Schema.Literal("cleanup") }),
  "cleanup-all": Schema.Struct({ op: Schema.Literal("cleanup-all") }),
  probe: Schema.Struct({ op: Schema.Literal("probe"), target: optional(Target) }),
} as const;

const TabGroupResult = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  color: Schema.String,
  collapsed: Schema.Boolean,
  windowId: Schema.Int,
});

export const FormattedTabResult = Schema.Struct({
  id: Schema.Int,
  windowId: Schema.Int,
  active: Schema.Boolean,
  highlighted: Schema.Boolean,
  title: Schema.String,
  url: Schema.String,
  status: optional(Schema.String),
  pinned: optional(Schema.Boolean),
  incognito: optional(Schema.Boolean),
  groupId: Schema.Int,
  group: Schema.NullOr(TabGroupResult),
});

const PngDataUrl = Schema.String.check(
  Schema.isPattern(
    /^data:image\/png;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/,
  ),
);
const JpegDataUrl = Schema.String.check(
  Schema.isPattern(
    /^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/,
  ),
);
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));

const viewportScreenshotResult = <const Format extends "png" | "jpeg">(
  format: Format,
  dataUrl: Schema.Codec<string>,
) =>
  Schema.Struct({
    kind: Schema.Literal("image"),
    format: Schema.Literal(format),
    dataUrl,
    tab: FormattedTabResult,
  });

const fullPageTilesResult = <const Format extends "png" | "jpeg">(
  format: Format,
  dataUrl: Schema.Codec<string>,
) =>
  Schema.Struct({
    kind: Schema.Literal("tile-set"),
    format: Schema.Literal(format),
    tab: FormattedTabResult,
    dimensions: Schema.Struct({
      width: PositiveFinite,
      height: PositiveFinite,
      viewportHeight: PositiveFinite,
      dpr: PositiveFinite,
    }),
    tiles: Schema.Array(
      Schema.Struct({
        y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
        dataUrl,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(SCREENSHOT_MAX_TILE_COUNT)),
  }).check(
    Schema.makeFilter((result) =>
      isCompleteFullPageTileSet(result.dimensions, result.tiles, SCREENSHOT_LIMITS)
        ? undefined
        : "Full-page tile-set geometry does not match its dimensions",
    ),
  );

export const ScreenshotResultSchemas = {
  viewport: {
    png: viewportScreenshotResult("png", PngDataUrl),
    jpeg: viewportScreenshotResult("jpeg", JpegDataUrl),
  },
  "full-page-tiles": {
    png: fullPageTilesResult("png", PngDataUrl),
    jpeg: fullPageTilesResult("jpeg", JpegDataUrl),
  },
} as const;

const AutomationTargetStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("allocating") }),
  Schema.Struct({
    state: Schema.Literal("owned"),
    tab: FormattedTabResult,
  }),
  Schema.Struct({
    state: Schema.Literal("stale"),
    reason: Schema.Literals(["epoch-changed", "tab-missing", "tab-outside-regular-profile"]),
    recordedTabId: Schema.NullOr(Schema.Int),
  }),
]);
const SessionAutomationTargetCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: AUTOMATION_TARGET_LIMITS.perSession }),
);
const ProfileAutomationTargetCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: AUTOMATION_TARGET_LIMITS.perProfile }),
);

export const AutomationStatusResult = Schema.Struct({
  targets: Schema.Array(AutomationTargetStatus).check(
    Schema.isMaxLength(AUTOMATION_TARGET_LIMITS.perSession),
  ),
  input: Schema.Struct({
    attachedTabs: Schema.Array(Schema.Int),
    permissionGranted: Schema.Boolean,
  }),
});

export const WaitResult = Schema.Struct({
  satisfied: Schema.Boolean,
  elapsedMs: NonNegativeInt,
  observation: Schema.Struct({
    url: Schema.String,
    title: Schema.String,
    readyState: Schema.Literals(["loading", "interactive", "complete"]),
    bodyTextLength: NonNegativeInt,
    matchCount: optional(NonNegativeInt),
  }),
});

export const CleanupResult = Schema.Struct({
  closedTabIds: Schema.Array(Schema.Int).check(
    Schema.isMaxLength(AUTOMATION_TARGET_LIMITS.perSession),
  ),
  staleOwnershipsCleared: SessionAutomationTargetCount,
});

export const CleanupAllResult = Schema.Struct({
  closedTabIds: Schema.Array(Schema.Int).check(
    Schema.isMaxLength(AUTOMATION_TARGET_LIMITS.perProfile),
  ),
  clearedSessionCount: ProfileAutomationTargetCount,
  staleOwnershipsCleared: ProfileAutomationTargetCount,
});
