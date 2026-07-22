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
  outputTokensPerSecond: number | null
}

export interface AssistantDisplaySegment {
  readonly kind: "event" | "process"
  readonly blocks: ReadonlyArray<AssistantContentBlock>
}

export interface StreamingOutputSample {
  readonly observedAt: number
  readonly outputUnits: number
  readonly streamElapsedMs?: number
}

export interface StreamingOutputThroughput {
  readonly tokensPerSecond: number
}

export type OutputRate =
  | { readonly kind: "estimated-live"; readonly tokensPerSecond: number }
  | { readonly kind: "measured-completed"; readonly tokensPerSecond: number }

export const projectCompletedOutputRate = (usage: TurnUsage): OutputRate | null =>
  usage.outputTokensPerSecond === null
    ? null
    : { kind: "measured-completed", tokensPerSecond: usage.outputTokensPerSecond }

const utf8 = new TextEncoder()

export function estimateStreamingOutputUnits(message: AssistantMessage): number {
  let outputBytes = 0
  for (const block of message.content ?? []) {
    if (block.type === "text") outputBytes += utf8.encode(block.text).byteLength
    else if (block.type === "thinking") outputBytes += utf8.encode(block.thinking).byteLength
    else if (block.type === "toolCall") outputBytes += utf8.encode(JSON.stringify(block.input)).byteLength
  }
  return outputBytes / 4
}

export function appendStreamingOutputSample(
  samples: ReadonlyArray<StreamingOutputSample>,
  next: StreamingOutputSample,
  windowMs = 2_000,
): ReadonlyArray<StreamingOutputSample> {
  const previous = samples.at(-1)
  if (
    previous !== undefined &&
    (next.observedAt < previous.observedAt ||
      next.outputUnits < previous.outputUnits ||
      (next.streamElapsedMs !== undefined &&
        previous.streamElapsedMs !== undefined &&
        next.streamElapsedMs < previous.streamElapsedMs))
  ) {
    return [next]
  }
  const appended = previous?.observedAt === next.observedAt ? [...samples.slice(0, -1), next] : [...samples, next]
  const cutoff = next.observedAt - windowMs
  const firstInside = appended.findIndex((sample) => sample.observedAt >= cutoff)
  if (firstInside <= 0) return appended
  return appended.slice(firstInside - 1)
}

export function projectStreamingOutputThroughput(
  samples: ReadonlyArray<StreamingOutputSample>,
): StreamingOutputThroughput | null {
  const first = samples[0]
  const last = samples.at(-1)
  if (first === undefined || last === undefined) return null
  const elapsedMs = last.observedAt - first.observedAt
  const outputUnits = last.outputUnits - first.outputUnits
  if (elapsedMs < 500 || outputUnits <= 0) return null
  return { tokensPerSecond: (outputUnits * 1_000) / elapsedMs }
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
    outputTokensPerSecond: null,
  }
  let usageRecords = 0
  let measuredOutputTokens = 0
  let generationDurationMs = 0
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
        if (message.generationDurationMs !== undefined && message.generationDurationMs > 0) {
          measuredOutputTokens += message.usage.output ?? 0
          generationDurationMs += message.generationDurationMs
        }
      }
    }
    if (message?.timestamp !== undefined) previousTimestamp = message.timestamp
  }

  if (usageRecords === 0) return null
  usage.models = [...models.values()]
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  usage.durationMs = elapsedDuration(turnStartedAt, turnEndedAt)
  usage.outputTokensPerSecond =
    generationDurationMs > 0 && measuredOutputTokens > 0 ? (measuredOutputTokens * 1_000) / generationDurationMs : null
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
