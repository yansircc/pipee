import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"

type IndexSearch = {
  readonly session?: string
}

export const Route = createFileRoute("/")({
  validateSearch: (input): IndexSearch => {
    const session = typeof input.session === "string" && input.session.length > 0 ? input.session : undefined
    return session === undefined ? {} : { session }
  },
  component: AppShell,
})
