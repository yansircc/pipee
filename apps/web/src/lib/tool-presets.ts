export interface ToolEntry {
  name: string
  description: string
  active: boolean
}

export type ToolPreset = "none" | "core" | "full"
export const DEFAULT_TOOL_PRESET: ToolPreset = "full"

export const PRESET_NONE: string[] = []
export const PRESET_CORE: string[] = ["read", "bash", "edit", "write"]
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "find", "ls"]

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL)

export function mergeBuiltinSelectionWithActiveExtensions(tools: ToolEntry[], builtinNames: string[]): string[] {
  const activeExtensionNames = tools
    .filter((tool) => tool.active && !BUILTIN_TOOL_NAMES.has(tool.name))
    .map((tool) => tool.name)
  return [...new Set([...builtinNames, ...activeExtensionNames])]
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeBuiltins = tools
    .filter((tool) => tool.active)
    .map((t) => t.name)
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
  if (activeBuiltins.length === 0) return "none"

  const active = activeBuiltins.sort().join(",")

  if (active === [...PRESET_CORE].sort().join(",")) return "core"
  if (active === [...PRESET_FULL].sort().join(",")) return "full"
  return "core"
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE]
  if (preset === "full") return [...PRESET_FULL]
  return [...PRESET_CORE]
}
