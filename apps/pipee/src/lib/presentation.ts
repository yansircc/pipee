import {
  PRESENTATION_DETAILS_KEY,
  PresentationDocument as PresentationDocumentSchema,
  type PresentationDocument,
} from "@pipee/companion-contracts/presentation"
import { Option, Schema } from "effect"

const decodePresentationDocument = Schema.decodeUnknownOption(PresentationDocumentSchema)

export type PresentationProjection =
  | { readonly _tag: "Valid"; readonly document: PresentationDocument }
  | { readonly _tag: "Invalid" }

export const presentationFromDetails = (details: unknown): PresentationProjection | null => {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null
  if (!Object.hasOwn(details, PRESENTATION_DETAILS_KEY)) return null
  return Option.match(decodePresentationDocument((details as Record<string, unknown>)[PRESENTATION_DETAILS_KEY]), {
    onNone: () => ({ _tag: "Invalid" as const }),
    onSome: (document) => ({ _tag: "Valid" as const, document }),
  })
}
