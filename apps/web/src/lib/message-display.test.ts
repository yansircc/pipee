import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/api/contract"
import { getDisplayableAssistantBlocks, splitFinalAssistantBlocks, summarizeTurnUsage } from "./message-display"

function assistant(content: AssistantContentBlock[]): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  }
}

test("splits trailing final answer blocks from process blocks", () => {
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ])

  const result = splitFinalAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(
    result.answerBlocks.map((block) => block.type),
    ["text", "image"],
  )
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["thinking", "toolCall"],
  )
})

test("keeps pre-tool text in process blocks", () => {
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ])

  const result = splitFinalAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(
    result.answerBlocks.map((block) => block.type),
    ["text"],
  )
  assert.deepEqual(result.answerBlocks[0], { type: "text", text: "Final answer" })
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["text", "toolCall"],
  )
})

test("does not expose text before a trailing tool call as final answer", () => {
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ])

  const result = splitFinalAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(result.answerBlocks, [])
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["thinking", "text", "toolCall"],
  )
})

test("drops empty thinking blocks after completion", () => {
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ])

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  )

  const result = splitFinalAssistantBlocks(message, { isStreaming: false })
  assert.deepEqual(
    result.answerBlocks.map((block) => block.type),
    ["text"],
  )
  assert.deepEqual(result.processBlocks, [])
})

test("keeps empty thinking while streaming", () => {
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ])

  const result = splitFinalAssistantBlocks(message, { isStreaming: true })

  assert.deepEqual(
    result.answerBlocks.map((block) => block.type),
    ["text"],
  )
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["thinking"],
  )
})

test("keeps deferred historical thinking placeholders", () => {
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ])

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  )
})

test("sums every assistant call within one user turn", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Investigate this site", timestamp: 1_000 },
    {
      ...assistant([{ type: "toolCall", toolCallId: "call-1", toolName: "browser", input: {} }]),
      timestamp: 2_500,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 300,
        cacheWrite: 10,
        cost: { input: 0.05, output: 0.05, cacheRead: 0.1, cacheWrite: 0.05, total: 0.25 },
      },
    },
    { role: "toolResult", toolCallId: "call-1", content: [], timestamp: 5_000 },
    {
      ...assistant([{ type: "text", text: "Final answer" }]),
      timestamp: 7_250,
      usage: {
        input: 50,
        output: 30,
        cacheRead: 400,
        cacheWrite: 0,
        cost: { input: 0.05, output: 0.3, cacheRead: 0.4, cacheWrite: 0, total: 0.75 },
      },
    },
    { role: "user", content: "Next turn" },
    {
      ...assistant([{ type: "text", text: "Not part of the first turn" }]),
      usage: {
        input: 999,
        output: 999,
        cacheRead: 999,
        cacheWrite: 999,
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
      },
    },
  ]

  assert.deepEqual(summarizeTurnUsage(messages, 0, 4), {
    modelCalls: 2,
    input: 150,
    output: 50,
    cacheRead: 700,
    cacheWrite: 10,
    totalTokens: 910,
    cost: 1,
    lastCallCost: 0.75,
    durationMs: 6_250,
    lastCallDurationMs: 2_250,
  })
})

test("does not invent turn usage when no assistant call has usage", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "Hello" }, assistant([{ type: "text", text: "Hello" }])]

  assert.equal(summarizeTurnUsage(messages, 0, messages.length), null)
})
