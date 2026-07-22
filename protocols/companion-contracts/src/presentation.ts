import { Schema } from "effect";

export const PRESENTATION_CONTRACT = "pipee/presentation@1" as const;
export const PRESENTATION_DETAILS_KEY = "pipeePresentation" as const;
export const PRESENTATION_LIMITS = {
  maxDepth: 8,
  maxNodes: 64,
  maxTextLength: 16_384,
} as const;

export const PresentationTone = Schema.Literals([
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
]);
export type PresentationTone = typeof PresentationTone.Type;

export const PresentationIcon = Schema.Literals([
  "automation",
  "messages",
  "browser",
  "extension",
  "event",
]);
export type PresentationIcon = typeof PresentationIcon.Type;

export type PresentationNode =
  | {
      readonly type: "group";
      readonly direction: "row" | "column";
      readonly gap: "small" | "medium";
      readonly children: ReadonlyArray<PresentationNode>;
    }
  | {
      readonly type: "text";
      readonly text: string;
      readonly variant: "title" | "body" | "caption";
      readonly tone?: PresentationTone;
    }
  | { readonly type: "badge"; readonly text: string; readonly tone: PresentationTone }
  | { readonly type: "field"; readonly label: string; readonly value: string }
  | { readonly type: "progress"; readonly value: number; readonly label?: string };

export const PresentationNode: Schema.Codec<PresentationNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("group"),
    direction: Schema.Literals(["row", "column"]),
    gap: Schema.Literals(["small", "medium"]),
    children: Schema.Array(Schema.suspend(() => PresentationNode)),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    variant: Schema.Literals(["title", "body", "caption"]),
    tone: Schema.optionalKey(PresentationTone),
  }),
  Schema.Struct({
    type: Schema.Literal("badge"),
    text: Schema.String,
    tone: PresentationTone,
  }),
  Schema.Struct({ type: Schema.Literal("field"), label: Schema.String, value: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    value: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    label: Schema.optionalKey(Schema.String),
  }),
]);

const validatePresentation = (
  root: PresentationNode | undefined,
  initialTextLength: number,
): string | undefined => {
  const pending: Array<{ readonly node: PresentationNode; readonly depth: number }> =
    root === undefined ? [] : [{ node: root, depth: 1 }];
  let nodes = 0;
  let textLength = initialTextLength;
  if (textLength > PRESENTATION_LIMITS.maxTextLength)
    return "Presentation text is too large";
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > PRESENTATION_LIMITS.maxNodes) return "Presentation has too many nodes";
    if (current.depth > PRESENTATION_LIMITS.maxDepth)
      return "Presentation is too deeply nested";
    const node = current.node;
    if (node.type === "group") {
      for (const child of node.children)
        pending.push({ node: child, depth: current.depth + 1 });
    } else if (node.type === "field") {
      textLength += node.label.length + node.value.length;
    } else if (node.type === "progress") {
      textLength += node.label?.length ?? 0;
    } else {
      textLength += node.text.length;
    }
    if (textLength > PRESENTATION_LIMITS.maxTextLength)
      return "Presentation text is too large";
  }
  return undefined;
};

export const PresentationDocument = Schema.Struct({
  contract: Schema.Literal(PRESENTATION_CONTRACT),
  title: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
  tone: PresentationTone,
  icon: PresentationIcon,
  status: Schema.optionalKey(
    Schema.Struct({ text: Schema.NonEmptyString, tone: PresentationTone }),
  ),
  body: Schema.optionalKey(PresentationNode),
}).check(
  Schema.makeFilter((document) =>
    validatePresentation(
      document.body,
      document.title.length +
        document.summary.length +
        (document.status?.text.length ?? 0),
    ),
  ),
);
export type PresentationDocument = typeof PresentationDocument.Type;

export const PresentationDetails = Schema.Struct({
  [PRESENTATION_DETAILS_KEY]: PresentationDocument,
});
export type PresentationDetails = typeof PresentationDetails.Type;
