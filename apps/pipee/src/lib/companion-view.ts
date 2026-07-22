import {
  COMPANION_VIEW_KEY,
  CompanionView as CompanionViewSchema,
  type CompanionView,
} from "@pipee/companion-contracts/companion-view"
import { Option, Schema } from "effect"

const decodeCompanionView = Schema.decodeUnknownOption(CompanionViewSchema)

export type CompanionViewProjection =
  | { readonly _tag: "Valid"; readonly view: CompanionView }
  | { readonly _tag: "Invalid" }

export const companionViewFromValue = (value: unknown): CompanionViewProjection | null => {
  if (typeof value !== "object" || value === null || !(COMPANION_VIEW_KEY in value)) return null
  return Option.match(decodeCompanionView((value as Record<string, unknown>)[COMPANION_VIEW_KEY]), {
    onNone: () => ({ _tag: "Invalid" as const }),
    onSome: (view) => ({ _tag: "Valid" as const, view }),
  })
}
