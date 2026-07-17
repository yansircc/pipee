import { expect, test } from "vite-plus/test"
import type { SessionEntry, UserMessage } from "@/api/contract"
import type { PiSessionDocument } from "./pi-agent-adapter"
import { buildSessionContext, buildSessionContextPage, projectSessionBranches } from "./session-repository"

const userEntry = (
  id: string,
  parentId: string | null,
  content: UserMessage["content"],
  timestamp = "2026-01-01T00:00:00.000Z",
): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role: "user", content },
})

const assistantEntry = (
  id: string,
  parentId: string | null,
  text: string,
  timestamp = "2026-01-01T00:00:00.000Z",
): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text }],
  },
})

const documentWith = (entries: ReadonlyArray<SessionEntry>): PiSessionDocument => ({
  filePath: "/sessions/session-1.jsonl",
  id: "session-1",
  cwd: "/repo",
  created: "2026-01-01T00:00:00.000Z",
  leafId: entries.at(-1)?.id ?? null,
  entries,
  thinkingLevel: "high",
  model: { provider: "test", modelId: "test-model" },
})

test("renders full branch history with compaction at its original entry position", () => {
  const entries: SessionEntry[] = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ]

  const context = buildSessionContext(documentWith(entries), {})
  expect(context.entryIds).toEqual(["u1", "a1", "u2", "cmp", "u3"])
  expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "custom", "user"])
})

test("preserves Pi bash execution messages and context exclusion", () => {
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "bash1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "bashExecution",
        command: "pwd",
        output: "/tmp\n",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1_700_000_000_000,
        excludeFromContext: true,
      },
    },
  ]
  const context = buildSessionContext(documentWith(entries), {})
  expect(context.entryIds).toEqual(["bash1"])
  expect(context.messages[0]).toMatchObject({ role: "bashExecution", excludeFromContext: true })
})

test("defers only non-empty historical thinking", () => {
  const reasoning: SessionEntry = {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [
        { type: "thinking", thinking: "large reasoning" },
        { type: "thinking", thinking: "" },
        { type: "text", text: "answer" },
      ],
    },
  }
  const document = documentWith([userEntry("u1", null, "start"), reasoning])
  const deferred = buildSessionContext(document, { deferThinking: true })
  expect(deferred.messages[1]).toMatchObject({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", deferred: true },
      { type: "thinking", thinking: "" },
      { type: "text", text: "answer" },
    ],
  })
  const full = buildSessionContext(document, {}).messages[1]
  expect(full?.role).toBe("assistant")
  if (full?.role === "assistant") {
    expect(full.content[0]).toEqual({ type: "thinking", thinking: "large reasoning" })
  }
})

test("defers base64 tool-result media but preserves user and URL images", () => {
  const userImage = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png",
      data: "QUJDRA==",
    },
  }
  const toolImage = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg",
      data: "QUJDRA==",
    },
  }
  const toolUrlImage = {
    type: "image" as const,
    source: {
      type: "url" as const,
      url: "https://example.com/result.png",
    },
  }
  const entries: SessionEntry[] = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [{ type: "text", text: "Read image file" }, toolImage, toolUrlImage],
      },
    },
  ]
  const deferred = buildSessionContext(documentWith(entries), { deferMedia: true })
  expect(deferred.messages[0]).toMatchObject({ content: [{ type: "text" }, userImage] })
  expect(deferred.messages[2]).toMatchObject({
    content: [
      { type: "text", text: "Read image file" },
      toolUrlImage,
      { type: "text", text: expect.stringMatching(/1 tool result image omitted.*image\/jpeg.*~4 bytes/) },
    ],
  })
})

test("preserves hidden custom messages and epoch timestamps", () => {
  const entries: SessionEntry[] = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
  ]
  const context = buildSessionContext(documentWith(entries), {})
  expect(context.messages[1]).toMatchObject({
    role: "custom",
    customType: "extension_debug",
    display: false,
    timestamp: 0,
  })
})

test("selects only the requested in-session branch", () => {
  const entries: SessionEntry[] = [
    userEntry("u1", null, "root"),
    assistantEntry("a1", "u1", "left"),
    assistantEntry("a2", "u1", "right"),
  ]
  expect(buildSessionContext(documentWith(entries), { leafId: "a1" }).entryIds).toEqual(["u1", "a1"])
  expect(buildSessionContext(documentWith(entries), { leafId: "a2" }).entryIds).toEqual(["u1", "a2"])
  expect(buildSessionContext(documentWith(entries), { leafId: null }).entryIds).toEqual([])
})

test("projects deep linear histories without recursive trees", () => {
  const entries: Array<SessionEntry> = []
  for (let index = 0; index < 5_000; index += 1) {
    entries.push(userEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `${index}`))
  }
  const projected = projectSessionBranches(entries)
  expect(projected).toHaveLength(2)
  expect(projected[0]).toMatchObject({ entryId: "entry-0", parentNodeId: null, compressedCount: 0 })
  expect(projected[1]).toMatchObject({ entryId: "entry-4999", parentNodeId: "entry-0" })
  expect(projected[1]).toMatchObject({ compressedCount: 4_998, active: true })
  expect(projectSessionBranches(entries, "entry-2500")[1]).toMatchObject({
    entryId: "entry-4999",
    active: true,
  })
})

test("projects branch points and leaves with derived labels", () => {
  const entries = [
    userEntry("root", null, "root"),
    assistantEntry("branch", "root", "branch"),
    userEntry("left", "branch", "left path"),
    userEntry("right", "branch", "right path"),
  ]
  expect(projectSessionBranches(entries)).toEqual([
    expect.objectContaining({ entryId: "root", parentNodeId: null, label: "root" }),
    expect.objectContaining({ entryId: "branch", parentNodeId: "root", label: "branch" }),
    expect.objectContaining({ entryId: "left", parentNodeId: "branch", label: "left path" }),
    expect.objectContaining({ entryId: "right", parentNodeId: "branch", label: "right path" }),
  ])
})

test("pages long contexts by stable entry cursor", () => {
  const entries: Array<SessionEntry> = []
  for (let index = 0; index < 300; index += 1) {
    entries.push(userEntry(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`, `${index}`))
  }
  const document = documentWith(entries)
  const latest = buildSessionContextPage(document, {})
  expect(latest.context.entryIds).toHaveLength(200)
  expect(latest.context.entryIds[0]).toBe("entry-100")
  expect(latest.beforeEntryId).toBe("entry-100")
  expect(latest.hasMoreBefore).toBe(true)

  const earlier = buildSessionContextPage(document, { beforeEntryId: latest.beforeEntryId ?? undefined })
  expect(earlier.context.entryIds).toHaveLength(100)
  expect(earlier.context.entryIds[0]).toBe("entry-0")
  expect(earlier.context.entryIds.at(-1)).toBe("entry-99")
  expect(earlier.beforeEntryId).toBeNull()
  expect(earlier.hasMoreBefore).toBe(false)
})
