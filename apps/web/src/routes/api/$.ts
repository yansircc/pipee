import { createFileRoute } from "@tanstack/react-router"
import { disposeApiTerminal, handleApiTerminalRequest } from "@/server/api-terminal"
import { registerApiTerminalDispose } from "@/server/api-terminal-lifecycle"

const unregisterApiTerminalDispose = registerApiTerminalDispose(disposeApiTerminal)

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: ({ request }) => handleApiTerminalRequest(request),
    },
  },
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterApiTerminalDispose()
    void disposeApiTerminal()
  })
}
