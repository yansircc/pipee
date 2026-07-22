import { Schema } from "effect";

export const CONVERSATION_VIEW_CONTRACT = "pipee/conversation-view@1" as const;
export const CONVERSATION_VIEW_DETAILS_KEY = "pipeeConversationView" as const;
export const CONVERSATION_VIEW_LIMITS = {
  maxDepth: 8,
  maxNodes: 64,
  maxTextLength: 16_384,
} as const;

export const ConversationViewTone = Schema.Literals([
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
]);
export type ConversationViewTone = typeof ConversationViewTone.Type;

export type ConversationViewNode =
  | {
      readonly type: "group";
      readonly direction: "row" | "column";
      readonly gap: "small" | "medium";
      readonly children: ReadonlyArray<ConversationViewNode>;
    }
  | {
      readonly type: "text";
      readonly text: string;
      readonly variant: "title" | "body" | "caption";
      readonly tone?: ConversationViewTone;
    }
  | { readonly type: "badge"; readonly text: string; readonly tone: ConversationViewTone }
  | { readonly type: "field"; readonly label: string; readonly value: string }
  | { readonly type: "progress"; readonly value: number; readonly label?: string };

export const ConversationViewNode: Schema.Codec<ConversationViewNode> = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("group"),
    direction: Schema.Literals(["row", "column"]),
    gap: Schema.Literals(["small", "medium"]),
    children: Schema.Array(Schema.suspend(() => ConversationViewNode)),
  }),
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
    variant: Schema.Literals(["title", "body", "caption"]),
    tone: Schema.optionalKey(ConversationViewTone),
  }),
  Schema.Struct({
    type: Schema.Literal("badge"),
    text: Schema.String,
    tone: ConversationViewTone,
  }),
  Schema.Struct({ type: Schema.Literal("field"), label: Schema.String, value: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("progress"),
    value: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    label: Schema.optionalKey(Schema.String),
  }),
]);

export const validateConversationViewTree = (
  root: ConversationViewNode,
  initialTextLength = 0,
): string | undefined => {
  const pending: Array<{ readonly node: ConversationViewNode; readonly depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodes = 0;
  let textLength = initialTextLength;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > CONVERSATION_VIEW_LIMITS.maxNodes) return "Conversation view has too many nodes";
    if (current.depth > CONVERSATION_VIEW_LIMITS.maxDepth)
      return "Conversation view is too deeply nested";
    const node = current.node;
    if (node.type === "group") {
      for (const child of node.children) pending.push({ node: child, depth: current.depth + 1 });
    } else if (node.type === "field") {
      textLength += node.label.length + node.value.length;
    } else if (node.type === "progress") {
      textLength += node.label?.length ?? 0;
    } else {
      textLength += node.text.length;
    }
    if (textLength > CONVERSATION_VIEW_LIMITS.maxTextLength)
      return "Conversation view text is too large";
  }
  return undefined;
};

export const ConversationView = Schema.Struct({
  contract: Schema.Literal(CONVERSATION_VIEW_CONTRACT),
  label: Schema.NonEmptyString,
  tone: ConversationViewTone,
  root: ConversationViewNode,
}).check(Schema.makeFilter((view) => validateConversationViewTree(view.root, view.label.length)));
export type ConversationView = typeof ConversationView.Type;

export const ConversationViewDetails = Schema.Struct({
  [CONVERSATION_VIEW_DETAILS_KEY]: ConversationView,
});
export type ConversationViewDetails = typeof ConversationViewDetails.Type;
