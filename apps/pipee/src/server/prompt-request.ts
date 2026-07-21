import { Schema } from "effect"
import { PromptRequestReceipt, RunId, type SessionEntry } from "@/api/contract"

export interface PromptInput {
  readonly message: string
  readonly images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>
}

export const PROMPT_REQUEST_ENTRY_TYPE = "pipee.prompt-request"

export const PromptRequestStarted = Schema.Struct({
  version: Schema.Literal(2),
  state: Schema.Literal("Started"),
  requestId: Schema.String,
  inputDigest: Schema.String,
  runId: RunId,
})

export const PromptRequestCompleted = Schema.Struct({
  version: Schema.Literal(2),
  state: Schema.Literal("Completed"),
  startedEntryId: Schema.String,
  text: Schema.String,
})

type PromptLedgerEntry = Readonly<{
  id: string
  parentId: string | null
  type: string
  customType?: string
  data?: unknown
}>

export type PromptRequestDecision =
  | { readonly _tag: "Begin" }
  | { readonly _tag: "Completed"; readonly runId: RunId; readonly text: string }
  | { readonly _tag: "PayloadMismatch" }
  | { readonly _tag: "InDoubt" }

export const canonicalPromptInput = (input: PromptInput): string =>
  JSON.stringify({
    message: input.message,
    images: (input.images ?? []).map((image) => ({
      type: image.type,
      data: image.data,
      mimeType: image.mimeType,
    })),
  })

export const decidePromptRequest = (
  entries: ReadonlyArray<PromptLedgerEntry>,
  requestId: string,
  inputDigest: string,
): PromptRequestDecision => {
  const started = entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== PROMPT_REQUEST_ENTRY_TYPE) return []
    const decoded = Schema.decodeUnknownOption(PromptRequestStarted)(entry.data)
    return decoded._tag === "Some" && decoded.value.requestId === requestId ? [{ entry, value: decoded.value }] : []
  })
  if (started.some(({ value }) => value.inputDigest !== inputDigest)) return { _tag: "PayloadMismatch" }
  if (started.length > 1) return { _tag: "InDoubt" }
  const request = started[0]
  if (request === undefined) return { _tag: "Begin" }

  const completion = entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== PROMPT_REQUEST_ENTRY_TYPE) return []
    const decoded = Schema.decodeUnknownOption(PromptRequestCompleted)(entry.data)
    return decoded._tag === "Some" && decoded.value.startedEntryId === request.entry.id ? [decoded.value] : []
  })
  if (completion.length === 1) {
    return { _tag: "Completed", runId: request.value.runId, text: completion[0]!.text }
  }
  return { _tag: "InDoubt" }
}

export const projectPromptRequestReceipts = (
  path: ReadonlyArray<SessionEntry>,
): ReadonlyArray<typeof PromptRequestReceipt.Type> => {
  const receipts: Array<typeof PromptRequestReceipt.Type> = []
  let active: { readonly startedEntryId: string; readonly index: number } | null = null

  for (const entry of path) {
    if (entry.type === "custom" && entry.customType === PROMPT_REQUEST_ENTRY_TYPE) {
      const started = Schema.decodeUnknownOption(PromptRequestStarted)(entry.data)
      if (started._tag === "Some") {
        receipts.push(
          PromptRequestReceipt.make({
            requestId: started.value.requestId,
            runId: started.value.runId,
          }),
        )
        active = { startedEntryId: entry.id, index: receipts.length - 1 }
        continue
      }
      const completed = Schema.decodeUnknownOption(PromptRequestCompleted)(entry.data)
      if (completed._tag === "Some" && active?.startedEntryId === completed.value.startedEntryId) active = null
      continue
    }
    if (active === null || entry.type !== "message") continue
    const receipt = receipts[active.index]
    if (receipt === undefined) continue
    if (entry.message.role === "user" && receipt.userEntryId === undefined) {
      receipts[active.index] = PromptRequestReceipt.make({ ...receipt, userEntryId: entry.id })
    } else if (entry.message.role === "assistant") {
      receipts[active.index] = PromptRequestReceipt.make({ ...receipt, assistantEntryId: entry.id })
    }
  }

  return receipts
}
