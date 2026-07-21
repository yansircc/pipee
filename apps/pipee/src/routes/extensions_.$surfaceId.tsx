import { createFileRoute } from "@tanstack/react-router"
import { ExtensionShell } from "@/components/ExtensionShell"

export const Route = createFileRoute("/extensions_/$surfaceId")({
  validateSearch: (input): { readonly returnSession?: string } => {
    const returnSession =
      typeof input.returnSession === "string" && input.returnSession.length > 0 ? input.returnSession : undefined
    return returnSession === undefined ? {} : { returnSession }
  },
  component: ExtensionSurface,
})

function ExtensionSurface() {
  const params = Route.useParams()
  const search = Route.useSearch()
  return <ExtensionShell surfaceId={params.surfaceId} returnSessionId={search.returnSession} />
}
