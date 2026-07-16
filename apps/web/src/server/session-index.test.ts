import { expect, it } from "vite-plus/test"
import { SessionInfo } from "@/api/contract"
import { activeSessionInfo, mergeSessionIndex } from "./session-index"

const storedSession = (firstMessage: string) =>
  SessionInfo.make({
    path: "/sessions/session-1.jsonl",
    id: "session-1",
    cwd: "/repo",
    created: "2026-07-15T00:00:00.000Z",
    modified: "2026-07-15T00:00:01.000Z",
    messageCount: 1,
    firstMessage,
    projectRoot: "/repo",
  })

const activeSession = (firstMessage: string | null = null) =>
  activeSessionInfo(
    {
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      cwd: "/repo",
      created: "2026-07-15T00:00:00.000Z",
      firstMessage,
    },
    { projectRoot: "/repo" },
  )

it("keeps an active session visible before its file is indexed", () => {
  const active = activeSession()
  expect(mergeSessionIndex([], [active])).toEqual([active])
})

it("uses the first accepted command as the active session title", () => {
  expect(activeSession("find the release date").firstMessage).toBe("find the release date")
})

it("replaces the active projection with the persisted session exactly once", () => {
  const stored = storedSession("hello")
  expect(mergeSessionIndex([stored], [activeSession()])).toEqual([stored])
})
