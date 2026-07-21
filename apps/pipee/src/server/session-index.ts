import { SessionInfo } from "@/api/contract"
import type { ActiveRuntimeSession } from "./session-runtime-registry"

export interface RuntimeProject {
  readonly projectRoot: string
  readonly worktreeBranch?: string
}

export const activeSessionInfo = (session: ActiveRuntimeSession, project: RuntimeProject): SessionInfo =>
  SessionInfo.make({
    path: session.sessionFile,
    id: session.sessionId,
    cwd: session.cwd,
    created: session.created,
    modified: session.created,
    messageCount: 0,
    firstMessage: session.firstMessage ?? "(no messages)",
    projectRoot: project.projectRoot,
    ...(project.worktreeBranch === undefined ? {} : { worktreeBranch: project.worktreeBranch }),
  })

export const mergeSessionIndex = (
  persisted: ReadonlyArray<SessionInfo>,
  active: ReadonlyArray<SessionInfo>,
): ReadonlyArray<SessionInfo> => {
  const persistedIds = new Set(persisted.map((session) => session.id))
  return [...persisted, ...active.filter((session) => !persistedIds.has(session.id))]
}
