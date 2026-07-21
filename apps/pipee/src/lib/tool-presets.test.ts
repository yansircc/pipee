import assert from "node:assert/strict"
import { test } from "vite-plus/test"

async function loadSubject() {
  return import("./tool-presets")
}

test("browser tools do not change the built-in tool preset", async () => {
  const { getPresetFromTools } = await loadSubject()

  assert.equal(
    getPresetFromTools([
      { name: "chrome_tab", description: "", active: true },
      { name: "read", description: "", active: false },
    ]),
    "none",
  )

  assert.equal(
    getPresetFromTools([
      { name: "chrome_tab", description: "", active: true },
      { name: "read", description: "", active: true },
      { name: "bash", description: "", active: true },
      { name: "edit", description: "", active: true },
      { name: "write", description: "", active: true },
    ]),
    "core",
  )
})

test("full is the single default preset", async () => {
  const { DEFAULT_TOOL_PRESET, getToolNamesForPreset, PRESET_FULL } = await loadSubject()

  assert.equal(DEFAULT_TOOL_PRESET, "full")
  assert.deepEqual(getToolNamesForPreset(DEFAULT_TOOL_PRESET), PRESET_FULL)
})

test("builtin preset changes preserve each extension's active state", async () => {
  const { mergeBuiltinSelectionWithActiveExtensions } = await loadSubject()
  const tools = [
    { name: "read", description: "", active: true },
    { name: "chrome_tab", description: "", active: true },
    { name: "inactive_extension", description: "", active: false },
  ]

  assert.deepEqual(mergeBuiltinSelectionWithActiveExtensions(tools, []), ["chrome_tab"])
  assert.deepEqual(mergeBuiltinSelectionWithActiveExtensions(tools, ["read", "bash"]), ["read", "bash", "chrome_tab"])
})
