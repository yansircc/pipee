import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  applicationAriaHotkey,
  formatApplicationHotkey,
  runApplicationCommand,
  type ApplicationCommand,
} from "./ApplicationCommands"
import { dispatchApplicationHotkey, resolveApplicationHotkey } from "./Hotkeys"

test("projects one hotkey definition into platform display and accessibility forms", () => {
  assert.equal(formatApplicationHotkey("Mod+Shift+O", true), "⌘⇧O")
  assert.equal(formatApplicationHotkey("Mod+Shift+O", false), "Ctrl+Shift+O")
  assert.equal(formatApplicationHotkey("Mod+,", true), "⌘,")
  assert.equal(applicationAriaHotkey("Mod+B", true), "Meta+B")
  assert.equal(applicationAriaHotkey("Mod+B", false), "Control+B")
  assert.equal(resolveApplicationHotkey("Mod+B", true), "Meta+B")
  assert.equal(resolveApplicationHotkey("Mod+B", false), "Control+B")
})

test("uses command availability as the only execution gate", () => {
  let executions = 0
  const command = (enabled: boolean): ApplicationCommand => ({
    id: "session.new",
    label: "New session",
    hotkey: "Mod+Shift+O",
    enabled,
    execute: () => {
      executions += 1
    },
  })
  assert.equal(runApplicationCommand(command(false)), false)
  assert.equal(executions, 0)
  assert.equal(runApplicationCommand(command(true)), true)
  assert.equal(executions, 1)
})

test("IME and an inner widget win before an application hotkey", () => {
  let executions = 0
  const command: ApplicationCommand = {
    id: "app.cancel",
    label: "Cancel",
    hotkey: "Escape",
    enabled: true,
    execute: () => {
      executions += 1
    },
  }
  const event = (overrides: Partial<KeyboardEvent>) =>
    ({
      defaultPrevented: false,
      isComposing: false,
      preventDefault() {},
      stopPropagation() {},
      ...overrides,
    }) as KeyboardEvent
  assert.equal(dispatchApplicationHotkey(command, event({ isComposing: true })), false)
  assert.equal(dispatchApplicationHotkey(command, event({ defaultPrevented: true })), false)
  assert.equal(executions, 0)
  assert.equal(dispatchApplicationHotkey(command, event({})), true)
  assert.equal(executions, 1)
})
