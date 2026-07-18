import { createFileRoute } from "@tanstack/react-router"
import { handleApiTerminalRequest } from "@/server/api-terminal"

export const Route = createFileRoute("/extension-assets/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleApiTerminalRequest(request),
    },
  },
})
