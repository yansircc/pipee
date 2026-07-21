import { expect, test, vi } from "vite-plus/test"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RunId, SessionEntry } from "@/api/contract"
import { matchExtensionInteractionResponse } from "./extension-ui-runtime"
import {
  findAgentSessionModel,
  normalizeAgentSessionName,
  normalizePiMessage,
  normalizeSessionStats,
} from "./pi-agent-adapter"
import { decodeOnExecution } from "./pi-adapter-errors"
import { canonicalPromptInput, decidePromptRequest, projectPromptRequestReceipts } from "./prompt-request"

test("normalizes Pi flat images and tool calls into the canonical API shape", () => {
  expect(
    normalizePiMessage({
      role: "user",
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  ).toEqual({
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" },
      },
    ],
  })

  expect(
    normalizePiMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
    }),
  ).toEqual({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCallId: "call-1",
        toolName: "read",
        input: { path: "README.md" },
      },
    ],
  })
})

test("normalizes agent-authored session names without creating a second title format", () => {
  expect(normalizeAgentSessionName("  修复   Chrome 配对与浏览器标题  ")).toBe("修复 Chrome 配对与浏览器标题")
  expect(normalizeAgentSessionName("长".repeat(40))).toBe("长".repeat(30))
})

test("resolves session models through the runtime-owned model catalog", () => {
  const model = { provider: "provider", id: "model" }
  const getModel = vi.fn((provider: string, modelId: string) =>
    provider === model.provider && modelId === model.id ? model : undefined,
  )

  expect(findAgentSessionModel({ modelRuntime: { getModel } }, model.provider, model.id)).toBe(model)
  expect(findAgentSessionModel({ modelRuntime: { getModel } }, model.provider, "missing")).toBeUndefined()
  expect(getModel).toHaveBeenCalledTimes(2)
})

it.effect("reads and decodes live runtime state only when the Effect executes", () =>
  Effect.gen(function* () {
    let value = 0
    const operation = decodeOnExecution(Schema.Struct({ value: Schema.Finite }), "runtime.fixture", () => ({
      value: ++value,
    }))

    expect(value).toBe(0)
    expect(yield* operation).toEqual({ value: 1 })
    expect(yield* operation).toEqual({ value: 2 })
  }),
)

test("normalizes unavailable Pi stats fields at the adapter boundary", () => {
  expect(
    normalizeSessionStats(
      {
        sessionFile: undefined,
        sessionId: "session-1",
        contextUsage: undefined,
        totalMessages: 0,
      },
      undefined,
    ),
  ).toEqual({ sessionId: "session-1", totalMessages: 0 })

  expect(normalizeSessionStats({ sessionId: "session-1", totalMessages: 1 }, "Named session")).toEqual({
    sessionId: "session-1",
    sessionName: "Named session",
    totalMessages: 1,
  })
})

const runId = RunId.make("run-1")
const started = {
  id: "request-entry",
  parentId: "previous-entry",
  type: "custom" as const,
  customType: "pipee.prompt-request",
  data: {
    version: 2 as const,
    state: "Started" as const,
    requestId: "message-42",
    inputDigest: "digest-1",
    runId,
  },
}

test("derives prompt request recovery from the append-only session ledger", () => {
  expect(decidePromptRequest([], "message-42", "digest-1")).toEqual({ _tag: "Begin" })
  expect(decidePromptRequest([started], "message-42", "digest-1")).toEqual({ _tag: "InDoubt" })
  expect(
    decidePromptRequest(
      [started, { id: "user-entry", parentId: "request-entry", type: "message" }],
      "message-42",
      "digest-1",
    ),
  ).toEqual({ _tag: "InDoubt" })
  expect(
    decidePromptRequest(
      [
        started,
        {
          id: "completed-entry",
          parentId: "assistant-entry",
          type: "custom",
          customType: "pipee.prompt-request",
          data: {
            version: 2,
            state: "Completed",
            startedEntryId: "request-entry",
            text: "done",
          },
        },
      ],
      "message-42",
      "digest-1",
    ),
  ).toEqual({ _tag: "Completed", runId, text: "done" })
  expect(decidePromptRequest([started], "message-42", "different-digest")).toEqual({
    _tag: "PayloadMismatch",
  })
})

test("projects request identity onto persisted user and assistant entries", () => {
  const timestamp = "2026-07-15T00:00:00.000Z"
  const entries = [
    SessionEntry.make({
      ...started,
      timestamp,
    }),
    SessionEntry.make({
      type: "message",
      id: "user-entry",
      parentId: "request-entry",
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ],
      },
    }),
    SessionEntry.make({
      type: "message",
      id: "assistant-entry",
      parentId: "user-entry",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "test-model",
        provider: "test-provider",
      },
    }),
  ]

  expect(projectPromptRequestReceipts(entries)).toEqual([
    {
      requestId: "message-42",
      runId,
      userEntryId: "user-entry",
      assistantEntryId: "assistant-entry",
    },
  ])
})

test("canonicalizes equivalent prompt payloads identically", () => {
  expect(
    canonicalPromptInput({
      message: "hello",
      images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
    }),
  ).toBe(
    canonicalPromptInput({
      images: [{ data: "aGVsbG8=", mimeType: "image/png", type: "image" }],
      message: "hello",
    }),
  )
})

test("accepts only responses belonging to the pending interaction kind", () => {
  const confirm = { interactionId: "interaction-1", method: "confirm" as const, title: "Continue?", message: "go" }
  expect(matchExtensionInteractionResponse(confirm, { _tag: "Confirmation", confirmed: true })).toEqual({
    _tag: "Accepted",
    value: { confirmed: true },
  })
  expect(matchExtensionInteractionResponse(confirm, { _tag: "Value", value: "yes" })).toEqual({
    _tag: "Rejected",
  })

  const input = { interactionId: "interaction-2", method: "input" as const, title: "Code" }
  expect(matchExtensionInteractionResponse(input, { _tag: "Value", value: "1234" })).toEqual({
    _tag: "Accepted",
    value: { value: "1234" },
  })
  expect(matchExtensionInteractionResponse(input, { _tag: "Confirmation", confirmed: true })).toEqual({
    _tag: "Rejected",
  })
  expect(matchExtensionInteractionResponse(input, { _tag: "Cancelled" })).toEqual({
    _tag: "Accepted",
    value: { cancelled: true },
  })
})
