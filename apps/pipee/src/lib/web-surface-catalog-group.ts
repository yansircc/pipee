import type {
  WebSurfaceCatalog,
  WebSurfaceCatalogItem,
  WebSurfaceSessionContext,
} from "@pipee/companion-contracts/web-surface"
import type { SessionIndex, SessionInfo } from "@/api/contract"
import type { WebSurfaceChannelBinding } from "@/browser/web-surface-channel"

export interface ResolvedWebSurfaceCatalog {
  readonly cwd: string
  readonly representative: SessionInfo
  readonly catalog: WebSurfaceCatalog
}

export interface WebSurfaceGroup {
  readonly item: WebSurfaceCatalogItem
  readonly bindings: ReadonlyArray<WebSurfaceChannelBinding>
}

export interface ExtensionCatalogState {
  readonly index: SessionIndex
  readonly groups: ReadonlyArray<WebSurfaceGroup>
  readonly diagnostics: ReadonlyArray<string>
}

export const webSurfaceSessionContext = (session: SessionInfo): WebSurfaceSessionContext => ({
  sessionId: session.id,
  cwd: session.cwd,
  name: session.name ?? null,
  projectRoot: session.projectRoot ?? null,
  modified: session.modified,
})

export const groupWebSurfaceCatalogs = (
  index: SessionIndex,
  catalogs: ReadonlyArray<ResolvedWebSurfaceCatalog>,
): ExtensionCatalogState => {
  const byCwd = new Map(catalogs.map((entry) => [entry.cwd, entry.catalog]))
  const candidates = new Map<string, Map<string, WebSurfaceCatalogItem>>()
  const diagnostics = catalogs.flatMap((entry) => entry.catalog.diagnostics.map((item) => item.message))
  for (const { catalog } of catalogs) {
    for (const surface of catalog.surfaces) {
      const variants = candidates.get(surface.surfaceId) ?? new Map<string, WebSurfaceCatalogItem>()
      variants.set(surface.candidateHash, surface)
      candidates.set(surface.surfaceId, variants)
    }
  }
  const running = new Set(index.runningSessionIds)
  const groups: Array<WebSurfaceGroup> = []
  for (const [surfaceId, variants] of candidates) {
    if (variants.size !== 1) {
      diagnostics.push(`Web Surface ${surfaceId} resolves to multiple candidate hashes`)
      continue
    }
    const item = [...variants.values()][0]!
    const compatibleSessions = index.sessions.filter((session) => {
      const catalog = byCwd.get(session.cwd)
      return catalog?.surfaces.some(
        (surface) => surface.surfaceId === item.surfaceId && surface.candidateHash === item.candidateHash,
      )
    })
    const activeBindings = compatibleSessions.flatMap((session): ReadonlyArray<WebSurfaceChannelBinding> => {
      if (!running.has(session.id)) return []
      const catalog = byCwd.get(session.cwd)
      const candidate = catalog?.surfaces.find(
        (surface) => surface.surfaceId === item.surfaceId && surface.candidateHash === item.candidateHash,
      )
      return candidate === undefined ? [] : [{ session: webSurfaceSessionContext(session), catalog: candidate }]
    })
    const fallback = [...compatibleSessions].sort((left, right) => right.modified.localeCompare(left.modified))[0]
    const bindings =
      activeBindings.length > 0 || fallback === undefined
        ? activeBindings
        : [
            {
              session: webSurfaceSessionContext(fallback),
              catalog: byCwd
                .get(fallback.cwd)!
                .surfaces.find(
                  (surface) => surface.surfaceId === item.surfaceId && surface.candidateHash === item.candidateHash,
                )!,
            },
          ]
    groups.push({ item, bindings })
  }
  groups.sort((left, right) => left.item.packageName.localeCompare(right.item.packageName))
  return { index, groups, diagnostics }
}
