import { createFileRoute } from "@tanstack/react-router"
import { ExtensionShell } from "@/components/ExtensionShell"

export const Route = createFileRoute("/extensions_/$surfaceId")({
  component: ExtensionSurface,
})

function ExtensionSurface() {
  const params = Route.useParams()
  return <ExtensionShell surfaceId={params.surfaceId} />
}
