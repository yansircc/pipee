import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ThinkingContent,
  ToolCallContent,
} from "@/api/contract"
import { elapsedDuration } from "./duration"

interface DisplayOptions {
  isStreaming?: boolean
}

export interface TurnUsage {
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

export function summarizeTurnUsage(messages: AgentMessage[], userIndex: number, endIndex: number): TurnUsage | null {
  const usage: TurnUsage = {
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
  const turnStartedAt = messages[userIndex]?.timestamp
  let previousTimestamp = turnStartedAt
  let turnEndedAt: number | undefined

  for (let index = userIndex + 1; index < endIndex; index++) {
    const message = messages[index]
    if (message?.role === "assistant") {
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

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image"
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options)
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block))
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] }
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  }
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length
}
