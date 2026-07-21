import { Effect } from "effect"
import {
  BrowserPreferences,
  ChatDraft as ChatDraftSchema,
  ChatDraftAttachment as ChatDraftAttachmentSchema,
  ChatDraftImage as ChatDraftImageSchema,
  browserPreferencesRef,
} from "@/browser/preferences"

export type ChatDraftImage = typeof ChatDraftImageSchema.Type
export type ChatDraftAttachment = typeof ChatDraftAttachmentSchema.Type
export type ChatDraft = typeof ChatDraftSchema.Type

const cloneDraft = (draft: ChatDraft): ChatDraft =>
  ChatDraftSchema.make({
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  })

const isEmptyDraft = (draft: ChatDraft): boolean =>
  !draft.value && draft.images.length === 0 && draft.attachments.length === 0

export function getDraft(key: string): ChatDraft | null {
  const draft = browserPreferencesRef.value.drafts[key]
  return draft ? cloneDraft(draft) : null
}

export const setDraft = (key: string, draft: ChatDraft) =>
  BrowserPreferences.pipe(
    Effect.flatMap((preferences) =>
      preferences.update((current) => {
        const drafts = { ...current.drafts }
        if (isEmptyDraft(draft)) delete drafts[key]
        else drafts[key] = cloneDraft(draft)
        return { ...current, drafts }
      }),
    ),
  )

export const clearDraft = (key: string) =>
  BrowserPreferences.pipe(
    Effect.flatMap((preferences) =>
      preferences.update((current) => {
        const drafts = { ...current.drafts }
        delete drafts[key]
        return { ...current, drafts }
      }),
    ),
  )
