import { describe, expect, it } from "vitest"
import type { AgentMessage, AssistantMessage } from "@/api/contract"
import type { TranscriptSource } from "@/features/session/session-ui-state"
import { compileConversationDocument } from "./conversation-document"

const source = (id: string, message: AgentMessage, runId: string | null = "run-1"): TranscriptSource => ({
  kind: "persisted",
  id: `entry:${id}`,
  entryId: id,
  runId,
  message,
})
const user = (content = "Please inspect this"): AgentMessage => ({ role: "user", content, timestamp: 100 })
const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AgentMessage => ({
  role: "assistant",
  content,
  model: "test-model",
  provider: "test-provider",
  timestamp: 200,
  ...extra,
})

describe("compileConversationDocument", () => {
  it("preserves assistant block order and lets content split traces", () => {
    const document = compileConversationDocument([
      source("u", user()),
      source(
        "a",
        assistant([
          { type: "text", text: "before" },
          { type: "thinking", thinking: "reason" },
          { type: "toolCall", toolCallId: "call", toolName: "unknown", input: { path: "x" } },
          { type: "text", text: "after" },
          { type: "thinking", thinking: "again" },
        ]),
      ),
      source("r", { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "ok" }] }),
    ])
    const turn = document.nodes[0]
    expect(turn.kind).toBe("turn")
    if (turn.kind !== "turn") return
    expect(turn.flow.map(({ kind }) => kind)).toEqual([
      "assistant-content",
      "agent-trace",
      "assistant-content",
      "agent-trace",
    ])
    const firstTrace = turn.flow[1]
    expect(firstTrace.kind).toBe("agent-trace")
    if (firstTrace.kind !== "agent-trace") return
    expect(firstTrace.items.map(({ kind }) => kind)).toEqual(["thinking", "tool"])
    expect(firstTrace.items[1]?.kind === "tool" ? firstTrace.items[1].result?.message.content : null).toEqual([
      { type: "text", text: "ok" },
    ])
  })

  it("pairs duplicate tool ids with the first unmatched call and exposes orphan results", () => {
    const document = compileConversationDocument([
      source("u", user()),
      source("a1", assistant([{ type: "toolCall", toolCallId: "same", toolName: "one", input: {} }])),
      source("a2", assistant([{ type: "toolCall", toolCallId: "same", toolName: "two", input: {} }])),
      source("r1", { role: "toolResult", toolCallId: "same", content: [{ type: "text", text: "first" }] }),
      source("r2", { role: "toolResult", toolCallId: "same", content: [{ type: "text", text: "second" }] }),
      source("r3", { role: "toolResult", toolCallId: "missing", content: [{ type: "text", text: "orphan" }] }),
    ])
    const turn = document.nodes[0]
    if (turn.kind !== "turn") throw new Error("expected turn")
    const items = turn.flow.flatMap((node) => (node.kind === "agent-trace" ? node.items : []))
    expect(items.map((item) => (item.kind === "tool" ? item.result?.message.content[0] : item.kind))).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      "unmatched-tool-result",
    ])
  })

  it("projects a validated tool result view into the conversation without duplicating its fact", () => {
    const document = compileConversationDocument([
      source("u", user()),
      source("a1", assistant([{ type: "toolCall", toolCallId: "view", toolName: "extension", input: {} }])),
      source("r", {
        role: "toolResult",
        toolCallId: "view",
        content: [{ type: "text", text: "Extension is ready" }],
        details: {
          pipeeConversationView: {
            contract: "pipee/conversation-view@1",
            label: "Fixture Extension",
            tone: "success",
            root: {
              type: "group",
              direction: "row",
              gap: "small",
              children: [
                { type: "text", text: "Connected", variant: "title" },
                { type: "badge", text: "Ready", tone: "success" },
              ],
            },
          },
        },
      }),
      source("a2", assistant([{ type: "text", text: "Done" }])),
    ])
    const turn = document.nodes[0]
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.flow.map(({ kind }) => kind)).toEqual(["agent-trace", "conversation-view", "assistant-content"])
    const view = turn.flow[1]
    expect(view.kind === "conversation-view" ? view.view?.label : null).toBe("Fixture Extension")
    const trace = turn.flow[0]
    expect(
      trace.kind === "agent-trace" && trace.items[0]?.kind === "tool" ? trace.items[0].result?.message : null,
    ).toMatchObject({ toolCallId: "view", details: { pipeeConversationView: { label: "Fixture Extension" } } })
  })

  it("projects invalid conversation metadata as a visible generic fallback", () => {
    const document = compileConversationDocument([
      source("u", user()),
      source("a", assistant([{ type: "toolCall", toolCallId: "invalid", toolName: "extension", input: {} }])),
      source("r", {
        role: "toolResult",
        toolCallId: "invalid",
        content: [{ type: "text", text: "Readable fallback" }],
        details: {
          pipeeConversationView: {
            contract: "pipee/conversation-view@1",
            label: "",
            tone: "success",
            root: { type: "progress", value: 2 },
          },
        },
      }),
    ])
    const turn = document.nodes[0]
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.flow.map(({ kind }) => kind)).toEqual(["agent-trace", "conversation-view"])
    const trace = turn.flow[0]
    expect(
      trace.kind === "agent-trace" && trace.items[0]?.kind === "tool" ? trace.items[0].result?.message.content : null,
    ).toEqual([{ type: "text", text: "Readable fallback" }])
    const fallback = turn.flow[1]
    expect(fallback.kind === "conversation-view" ? fallback.view : undefined).toBeNull()
  })

  it("uses run identity for turns and projects commands, compaction, custom and termination", () => {
    const document = compileConversationDocument([
      source("u", user("A very long prompt"), "run-9"),
      source("custom", { role: "custom", customType: "notice", content: "inside", display: true }),
      source("a", assistant([], { stopReason: "aborted" })),
      source(
        "bash",
        {
          role: "bashExecution",
          command: "pwd",
          output: "/tmp",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 300,
        },
        null,
      ),
      source("compact", { role: "custom", customType: "compaction", content: "summary", display: true }, null),
      source("outside", { role: "custom", customType: "status", content: "hidden", display: false }, null),
    ])
    expect(document.nodes.map(({ kind }) => kind)).toEqual([
      "turn",
      "user-command",
      "context-boundary",
      "extension-entry",
    ])
    const turn = document.nodes[0]
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.id).toBe("turn:run-9")
    expect(turn.flow.map(({ kind }) => kind)).toEqual(["extension-content", "termination"])
    expect(document.turnIndex).toEqual([
      { turnId: "turn:run-9", nodeIndex: 0, rowId: "turn:run-9", promptPreview: "A very long prompt" },
    ])
  })

  it("is deterministic and only derives completed TPS from measured generation duration", () => {
    const sources = [
      source("u", user()),
      source(
        "a",
        assistant([{ type: "text", text: "done" }], {
          generationDurationMs: 2_000,
          usage: {
            input: 3,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      ),
    ]
    const first = compileConversationDocument(sources)
    expect(compileConversationDocument(sources)).toEqual(first)
    const turn = first.nodes[0]
    expect(turn.kind === "turn" ? turn.telemetry?.outputTokensPerSecond : null).toBe(5)
  })

  it("reuses unchanged completed turns while an active turn grows", () => {
    const stable = [
      source("u1", user("stable"), "run-1"),
      source("a1", assistant([{ type: "text", text: "done" }]), "run-1"),
    ]
    const liveUser = source("u2", user("live"), "run-2")
    const first = compileConversationDocument(
      [...stable, liveUser, source("live", assistant([{ type: "text", text: "a" }]), "run-2")],
      { liveRunId: "run-2" },
    )
    const second = compileConversationDocument(
      [...stable, liveUser, source("live", assistant([{ type: "text", text: "ab" }]), "run-2")],
      { liveRunId: "run-2" },
      first,
    )
    expect(second.nodes[0]).toBe(first.nodes[0])
    expect(second.nodes[1]).not.toBe(first.nodes[1])
  })

  it("keeps turn and flow identities stable when live facts become persisted entries", () => {
    const userMessage = user("stable identity")
    const assistantMessage = assistant([
      { type: "text", text: "answer" },
      { type: "toolCall", toolCallId: "c", toolName: "tool", input: {} },
    ])
    const live = compileConversationDocument(
      [
        { kind: "pending", id: "request:q", requestId: "q", runId: "r", message: userMessage },
        { kind: "streaming", id: "run:r:stream", runId: "r", message: assistantMessage },
      ],
      { liveRunId: "r" },
    )
    const completed = compileConversationDocument([
      { kind: "persisted", id: "entry:u", entryId: "u", runId: "r", message: userMessage },
      { kind: "persisted", id: "entry:a", entryId: "a", runId: "r", message: assistantMessage },
    ])
    const identities = (document: typeof live) => {
      const turn = document.nodes[0]
      if (turn.kind !== "turn") throw new Error("expected turn")
      return [turn.id, ...turn.flow.map(({ id }) => id)]
    }
    expect(identities(completed)).toEqual(identities(live))
  })
})
