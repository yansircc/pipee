import { Schema } from "effect";
import {
  ConversationViewNode,
  ConversationViewTone,
  validateConversationViewTree,
} from "./conversation-view.js";

export const COMPANION_VIEW_CONTRACT = "pipee/companion-view@1" as const;
export const COMPANION_VIEW_KEY = "pipeeCompanionView" as const;

export const CompanionViewGlyph = Schema.Literals([
  "automation",
  "messages",
  "browser",
  "extension",
]);
export type CompanionViewGlyph = typeof CompanionViewGlyph.Type;

export const CompanionView = Schema.Struct({
  contract: Schema.Literal(COMPANION_VIEW_CONTRACT),
  label: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  summary: Schema.NonEmptyString,
  tone: ConversationViewTone,
  glyph: CompanionViewGlyph,
  details: Schema.optionalKey(ConversationViewNode),
}).check(
  Schema.makeFilter((view) =>
    view.details === undefined
      ? undefined
      : validateConversationViewTree(
          view.details,
          view.label.length + view.state.length + view.summary.length,
        ),
  ),
);
export type CompanionView = typeof CompanionView.Type;

export const CompanionViewDetails = Schema.Struct({
  [COMPANION_VIEW_KEY]: CompanionView,
});
export type CompanionViewDetails = typeof CompanionViewDetails.Type;
