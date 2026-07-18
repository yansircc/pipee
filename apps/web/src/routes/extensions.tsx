import { createFileRoute } from "@tanstack/react-router"
import { ExtensionShell, validateExtensionSearch } from "@/components/ExtensionShell"

export const Route = createFileRoute("/extensions")({
  validateSearch: validateExtensionSearch,
  component: Extensions,
})

function Extensions() {
  const search = Route.useSearch()
  return <ExtensionShell sessionId={search.session} />
}
