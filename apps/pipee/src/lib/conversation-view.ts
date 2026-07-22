import {
  CONVERSATION_VIEW_DETAILS_KEY,
  ConversationView as ConversationViewSchema,
  type ConversationView,
} from "@pipee/companion-contracts/conversation-view"
import { Option, Schema } from "effect"

const decodeConversationView = Schema.decodeUnknownOption(ConversationViewSchema)

export type ConversationViewProjection =
  | { readonly _tag: "Valid"; readonly view: ConversationView }
  | { readonly _tag: "Invalid" }

export const conversationViewFromDetails = (details: unknown): ConversationViewProjection | null => {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null
  if (!Object.hasOwn(details, CONVERSATION_VIEW_DETAILS_KEY)) return null
  return Option.match(decodeConversationView((details as Record<string, unknown>)[CONVERSATION_VIEW_DETAILS_KEY]), {
    onNone: () => ({ _tag: "Invalid" as const }),
    onSome: (view) => ({ _tag: "Valid" as const, view }),
  })
}
