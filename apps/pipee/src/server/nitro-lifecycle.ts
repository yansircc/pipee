import { definePlugin } from "nitro"
import { disposeRegisteredApiTerminal } from "./api-terminal-lifecycle"

export default definePlugin((nitroApp) => {
  const disposeOnSignal = () => {
    void disposeRegisteredApiTerminal()
  }
  process.on("SIGINT", disposeOnSignal)
  process.on("SIGTERM", disposeOnSignal)
  nitroApp.hooks.hook("close", () => {
    process.off("SIGINT", disposeOnSignal)
    process.off("SIGTERM", disposeOnSignal)
    return disposeRegisteredApiTerminal()
  })
})
