import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent } from "@/api/contract"
import { elapsedDuration } from "./duration"

interface DisplayOptions {
  isStreaming?: boolean
}

export interface TurnUsage {
  models: ReadonlyArray<{ provider: string; model: string }>
  modelCalls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: number
  lastCallCost: number | null
  durationMs: number | null
  lastCallDurationMs: number | null
}

export interface AssistantDisplaySegment {
  readonly kind: "event" | "process"
  readonly blocks: ReadonlyArray<AssistantContentBlock>
}

export function summarizeTurnUsage(messages: AgentMessage[], userIndex: number, endIndex: number): TurnUsage | null {
  const usage: TurnUsage = {
    models: [],
    modelCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    lastCallCost: null,
    durationMs: null,
    lastCallDurationMs: null,
  }
  let usageRecords = 0
  const models = new Map<string, { provider: string; model: string }>()
  const turnStartedAt = messages[userIndex]?.timestamp
  let previousTimestamp = turnStartedAt
  let turnEndedAt: number | undefined

  for (let index = userIndex + 1; index < endIndex; index++) {
    const message = messages[index]
    if (message?.role === "assistant") {
      if (message.provider && message.model) {
        models.set(`${message.provider}:${message.model}`, {
          provider: message.provider,
          model: message.model,
        })
      }
      usage.modelCalls += 1
      usage.lastCallCost = message.usage?.cost?.total ?? null
      usage.lastCallDurationMs = elapsedDuration(previousTimestamp, message.timestamp)
      if (message.timestamp !== undefined) turnEndedAt = message.timestamp
      if (message.usage) {
        usageRecords += 1
        usage.input += message.usage.input ?? 0
        usage.output += message.usage.output ?? 0
        usage.cacheRead += message.usage.cacheRead ?? 0
        usage.cacheWrite += message.usage.cacheWrite ?? 0
        usage.cost += message.usage.cost?.total ?? 0
      }
    }
    if (message?.timestamp !== undefined) previousTimestamp = message.timestamp
  }

  if (usageRecords === 0) return null
  usage.models = [...models.values()]
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  usage.durationMs = elapsedDuration(turnStartedAt, turnEndedAt)
  return usage
}

export function isEmptyThinkingBlock(
  block: AssistantContentBlock,
  options: DisplayOptions = {},
): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === ""
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options))
}

function isConversationEventBlock(block: AssistantContentBlock): boolean {
  return block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
}

export function partitionAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { eventBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options)
  return {
    eventBlocks: blocks.filter(isConversationEventBlock),
    processBlocks: blocks.filter((block) => !isConversationEventBlock(block)),
  }
}

export function segmentAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): ReadonlyArray<AssistantDisplaySegment> {
  const segments: Array<{ kind: "event" | "process"; blocks: AssistantContentBlock[] }> = []
  for (const block of getDisplayableAssistantBlocks(message, options)) {
    const kind = isConversationEventBlock(block) ? "event" : "process"
    const previous = segments.at(-1)
    if (previous?.kind === kind) previous.blocks.push(block)
    else segments.push({ kind, blocks: [block] })
  }
  return segments
}
