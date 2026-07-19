import { createFileRoute } from "@tanstack/react-router"
import { ExtensionShell } from "@/components/ExtensionShell"

export const Route = createFileRoute("/extensions")({
  component: Extensions,
})

function Extensions() {
  return <ExtensionShell />
}
