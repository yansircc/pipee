import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import type { AgentMessage, AssistantContentBlock, AssistantMessage } from "@/api/contract"
import {
  appendStreamingOutputSample,
  estimateStreamingOutputUnits,
  getDisplayableAssistantBlocks,
  partitionAssistantBlocks,
  projectStreamingOutputThroughput,
  segmentAssistantBlocks,
  summarizeTurnUsage,
  type StreamingOutputSample,
} from "./message-display"

function assistant(content: AssistantContentBlock[]): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  }
}

test("estimates live output units from UTF-8 volume without switching to provider usage", () => {
  assert.equal(estimateStreamingOutputUnits(assistant([{ type: "text", text: "a".repeat(12) }])), 3)
  assert.equal(estimateStreamingOutputUnits(assistant([{ type: "text", text: "中文" }])), 1.5)
  assert.equal(
    estimateStreamingOutputUnits({
      ...assistant([{ type: "text", text: "abcd" }]),
      usage: {
        input: 10,
        output: 500,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }),
    1,
  )
})

test("projects a stable recent rate and removes output older than the window", () => {
  let samples = appendStreamingOutputSample([], { observedAt: 0, outputUnits: 0 })
  samples = appendStreamingOutputSample(samples, { observedAt: 1_000, outputUnits: 20 })
  assert.deepEqual(projectStreamingOutputThroughput(samples), { tokensPerSecond: 20 })
  samples = appendStreamingOutputSample(samples, { observedAt: 2_000, outputUnits: 40 })
  assert.deepEqual(projectStreamingOutputThroughput(samples), { tokensPerSecond: 20 })
  samples = appendStreamingOutputSample(samples, { observedAt: 3_000, outputUnits: 60 })
  assert.deepEqual(projectStreamingOutputThroughput(samples), { tokensPerSecond: 20 })
  samples = appendStreamingOutputSample(samples, { observedAt: 5_001, outputUnits: 60 })
  assert.equal(projectStreamingOutputThroughput(samples), null)
})

test("is invariant to chunk boundaries and resets when a new stream starts", () => {
  const coarse = [
    { observedAt: 0, outputUnits: 0, streamElapsedMs: 0 },
    { observedAt: 2_000, outputUnits: 40, streamElapsedMs: 2_000 },
  ].reduce<ReadonlyArray<StreamingOutputSample>>((samples, next) => appendStreamingOutputSample(samples, next), [])
  const fine = [
    { observedAt: 0, outputUnits: 0, streamElapsedMs: 0 },
    { observedAt: 500, outputUnits: 10, streamElapsedMs: 500 },
    { observedAt: 1_000, outputUnits: 20, streamElapsedMs: 1_000 },
    { observedAt: 1_500, outputUnits: 30, streamElapsedMs: 1_500 },
    { observedAt: 2_000, outputUnits: 40, streamElapsedMs: 2_000 },
  ].reduce<ReadonlyArray<StreamingOutputSample>>((samples, next) => appendStreamingOutputSample(samples, next), [])
  assert.deepEqual(projectStreamingOutputThroughput(coarse), { tokensPerSecond: 20 })
  assert.deepEqual(projectStreamingOutputThroughput(fine), { tokensPerSecond: 20 })

  const reset = appendStreamingOutputSample(fine, {
    observedAt: 2_500,
    outputUnits: 50,
    streamElapsedMs: 100,
  })
  assert.deepEqual(reset, [{ observedAt: 2_500, outputUnits: 50, streamElapsedMs: 100 }])
  assert.equal(projectStreamingOutputThroughput(reset), null)
})

test("partitions public assistant events from process blocks", () => {
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ])

  const result = partitionAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(
    result.eventBlocks.map((block) => block.type),
    ["text", "image"],
  )
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["thinking", "toolCall"],
  )
})

test("keeps pre-tool text as a conversation event", () => {
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ])

  const result = partitionAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(
    result.eventBlocks.map((block) => block.type),
    ["text", "text"],
  )
  assert.deepEqual(result.eventBlocks[0], { type: "text", text: "I will inspect the repo first." })
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["toolCall"],
  )
})

test("keeps assistant speech public even when a tool call follows it", () => {
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ])

  const result = partitionAssistantBlocks(message, { isStreaming: false })

  assert.deepEqual(result.eventBlocks, [{ type: "text", text: "I need to call a tool." }])
  assert.deepEqual(
    result.processBlocks.map((block) => block.type),
    ["thinking", "toolCall"],
  )
})

test("segments assistant blocks without changing their event and process order", () => {
  const message = assistant([
    { type: "thinking", thinking: "first" },
    { type: "text", text: "visible one" },
    { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "one.ts" } },
    { type: "text", text: "visible two" },
    { type: "thinking", thinking: "last" },
  ])

  assert.deepEqual(segmentAssistantBlocks(message), [
    { kind: "process", blocks: [message.content[0]] },
    { kind: "event", blocks: [message.content[1]] },
    { kind: "process", blocks: [message.content[2]] },
    { kind: "event", blocks: [message.content[3]] },
    { kind: "process", blocks: [message.content[4]] },
  ])
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

  const result = partitionAssistantBlocks(message, { isStreaming: false })
  assert.deepEqual(
    result.eventBlocks.map((block) => block.type),
    ["text"],
  )
  assert.deepEqual(result.processBlocks, [])
})

test("keeps empty thinking while streaming", () => {
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ])

  const result = partitionAssistantBlocks(message, { isStreaming: true })

  assert.deepEqual(
    result.eventBlocks.map((block) => block.type),
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
      generationDurationMs: 1_000,
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
      generationDurationMs: 2_000,
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
    models: [{ provider: "test", model: "test-model" }],
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
    outputTokensPerSecond: 50 / 3,
  })
})

test("does not invent output throughput without a measured stream duration", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Hello", timestamp: 1_000 },
    {
      ...assistant([{ type: "text", text: "Hello" }]),
      timestamp: 2_000,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  ]

  assert.equal(summarizeTurnUsage(messages, 0, messages.length)?.outputTokensPerSecond, null)
})

test("does not invent turn usage when no assistant call has usage", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "Hello" }, assistant([{ type: "text", text: "Hello" }])]

  assert.equal(summarizeTurnUsage(messages, 0, messages.length), null)
})
