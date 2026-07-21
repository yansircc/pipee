import { describe, expect, it, vi } from "vite-plus/test"
import { disposeRegisteredApiTerminal, registerApiTerminalDispose } from "./api-terminal-lifecycle"

describe("API terminal lifecycle", () => {
  it("disposes the current terminal and ignores stale unregister calls", async () => {
    const first = vi.fn(async () => undefined)
    const second = vi.fn(async () => undefined)
    const unregisterFirst = registerApiTerminalDispose(first)
    const unregisterSecond = registerApiTerminalDispose(second)

    unregisterFirst()
    await disposeRegisteredApiTerminal()
    unregisterSecond()
    await disposeRegisteredApiTerminal()

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
