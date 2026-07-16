import { expect, test } from "vite-plus/test"
import { RunId, SessionEntry } from "@/api/contract"
import { normalizePiMessage, normalizePiTree } from "./pi-agent-adapter"
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

test("omits SDK undefined tree metadata at the API boundary", () => {
  expect(
    normalizePiTree({
      entry: { type: "message", id: "root", parentId: null },
      children: [],
      label: undefined,
      labelTimestamp: undefined,
    }),
  ).toEqual({
    entry: { type: "message", id: "root", parentId: null },
    children: [],
  })
})

const runId = RunId.make("run-1")
const started = {
  id: "request-entry",
  parentId: "previous-entry",
  type: "custom" as const,
  customType: "pi-web.prompt-request",
  data: {
    version: 1 as const,
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
          customType: "pi-web.prompt-request",
          data: {
            version: 1,
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
