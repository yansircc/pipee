import { createFileRoute } from "@tanstack/react-router"
import { ExtensionShell, validateExtensionSearch } from "@/components/ExtensionShell"

export const Route = createFileRoute("/extensions_/$surfaceId")({
  validateSearch: validateExtensionSearch,
  component: ExtensionSurface,
})

function ExtensionSurface() {
  const search = Route.useSearch()
  const params = Route.useParams()
  return <ExtensionShell sessionId={search.session} surfaceId={params.surfaceId} />
}
