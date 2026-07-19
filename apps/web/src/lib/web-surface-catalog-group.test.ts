import { describe, expect, it } from "vitest"
import { SessionInfo, type SessionIndex } from "@/api/contract"
import type { WebSurfaceCatalogItem } from "@pi-suite/companion-contracts/web-surface"
import { groupWebSurfaceCatalogs, type ResolvedWebSurfaceCatalog } from "./web-surface-catalog-group"

const session = (id: string, cwd: string, modified: string) =>
  SessionInfo.make({
    path: `/sessions/${id}.jsonl`,
    id,
    cwd,
    name: id,
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 1,
    firstMessage: id,
  })

const surface = (candidateHash: string): WebSurfaceCatalogItem =>
  ({
    packageName: "@yansircc/pi-loop",
    surfaceId: "QHlhbnNpcmNjL3BpLWxvb3A",
    candidateHash,
    title: "Loop 自动化",
    documentUrl: "/extension-assets/session/surface/hash/index.html",
  }) as WebSurfaceCatalogItem

const catalog = (
  representative: ReturnType<typeof session>,
  item: WebSurfaceCatalogItem,
): ResolvedWebSurfaceCatalog => ({
  cwd: representative.cwd,
  representative,
  catalog: { surfaces: [item], diagnostics: [] },
})

describe("global Web Surface catalog grouping", () => {
  it("binds every running compatible Session to one candidate", () => {
    const left = session("left", "/workspace/a", "2026-01-01T00:00:00.000Z")
    const right = session("right", "/workspace/b", "2026-01-02T00:00:00.000Z")
    const item = surface("a".repeat(64))
    const index: SessionIndex = { sessions: [left, right], runningSessionIds: [left.id, right.id] }
    const grouped = groupWebSurfaceCatalogs(index, [catalog(left, item), catalog(right, item)])
    expect(grouped.groups).toHaveLength(1)
    expect(grouped.groups[0]?.bindings.map((binding) => binding.session.sessionId)).toEqual(["left", "right"])
  })

  it("uses only the newest compatible Session as a dormant activation anchor", () => {
    const older = session("older", "/workspace/a", "2026-01-01T00:00:00.000Z")
    const newer = session("newer", "/workspace/a", "2026-01-02T00:00:00.000Z")
    const item = surface("b".repeat(64))
    const index: SessionIndex = { sessions: [older, newer], runningSessionIds: [] }
    const grouped = groupWebSurfaceCatalogs(index, [catalog(newer, item)])
    expect(grouped.groups[0]?.bindings.map((binding) => binding.session.sessionId)).toEqual(["newer"])
  })

  it("fails closed when one surface id resolves to multiple candidates", () => {
    const left = session("left", "/workspace/a", "2026-01-01T00:00:00.000Z")
    const right = session("right", "/workspace/b", "2026-01-02T00:00:00.000Z")
    const index: SessionIndex = { sessions: [left, right], runningSessionIds: [left.id, right.id] }
    const grouped = groupWebSurfaceCatalogs(index, [
      catalog(left, surface("a".repeat(64))),
      catalog(right, surface("b".repeat(64))),
    ])
    expect(grouped.groups).toEqual([])
    expect(grouped.diagnostics).toContainEqual(expect.stringContaining("multiple candidate hashes"))
  })
})
