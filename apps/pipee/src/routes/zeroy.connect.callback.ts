import { createFileRoute } from "@tanstack/react-router"
import { handleApiTerminalRequest } from "@/server/api-terminal"

/**
 * Pipee zeroY pairing callback (/zeroy/connect/callback).
 *
 * WordPress redirects the browser here after an administrator approves a
 * Pipee-initiated intent. The effect router owns the exchange and returns a
 * plain HTML result page, so this route forwards the raw request instead of
 * rendering a client component.
 */
export const Route = createFileRoute("/zeroy/connect/callback")({
  server: {
    handlers: {
      GET: ({ request }) => handleApiTerminalRequest(request),
    },
  },
})
