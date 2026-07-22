import { describe, expect, it } from "vitest"
import type { TranscriptSource } from "@/features/session/session-ui-state"
import { compileConversationDocument } from "./conversation-document"
import { emptyDisclosureState, projectDisclosure } from "./disclosure-projection"

const sources: TranscriptSource[] = [
  {
    kind: "persisted",
    id: "entry:u",
    entryId: "u",
    runId: "r",
    message: { role: "user", content: "go", timestamp: 0 },
  },
  {
    kind: "persisted",
    id: "entry:a",
    entryId: "a",
    runId: "r",
    message: {
      role: "assistant",
      model: "m",
      provider: "p",
      timestamp: 2_000,
      content: [
        { type: "text", text: "visible" },
        { type: "thinking", thinking: "why" },
        { type: "toolCall", toolCallId: "c", toolName: "mystery", input: { x: true } },
      ],
    },
  },
  {
    kind: "persisted",
    id: "entry:r",
    entryId: "r",
    runId: "r",
    message: {
      role: "toolResult",
      toolCallId: "c",
      isError: true,
      content: [{ type: "text", text: "failed" }],
    },
  },
]

describe("projectDisclosure", () => {
  it("keeps assistant content visible and collapses completed traces", () => {
    const document = compileConversationDocument(sources)
    const rows = projectDisclosure(document, emptyDisclosureState())
    expect(rows.map(({ kind }) => kind)).toEqual(["turn-user", "assistant-content", "agent-trace"])
    const trace = rows[2]
    if (trace.kind !== "agent-trace") throw new Error("expected trace")
    expect(trace.summary).toBe("Worked for 2s · 2 actions")
    expect(trace.visibleItems).toEqual([])
    const expanded = projectDisclosure(
      document,
      { ...emptyDisclosureState(), expandedTraceIds: new Set([trace.id]) },
      rows,
    )
    const expandedTrace = expanded[2]
    expect(expandedTrace.kind === "agent-trace" ? expandedTrace.visibleItems.map(({ kind }) => kind) : []).toEqual([
      "thinking",
      "tool",
    ])
    expect(expanded[0]).toBe(rows[0])
    expect(expanded[1]).toBe(rows[1])
  })

  it("shows only the current live action and never invents tool semantics", () => {
    const document = compileConversationDocument(sources, { liveRunId: "r" })
    const rows = projectDisclosure(document, emptyDisclosureState())
    const trace = rows.find((row) => row.kind === "agent-trace")
    if (trace?.kind !== "agent-trace") throw new Error("expected trace")
    expect(trace.summary).toBe("Running mystery")
    expect(trace.visibleItems).toHaveLength(1)
    expect(trace.visibleItems[0]?.kind).toBe("tool")
  })
})
