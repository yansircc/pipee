export type ApplicationCommandId =
  | "session.new"
  | "composer.focus"
  | "app.cancel"
  | "commandPalette.open"
  | "sidebar.toggle"
  | "settings.toggle"
  | "workspace.resources.open"

export interface ApplicationCommand {
  readonly id: ApplicationCommandId
  readonly label: string
  readonly hotkey?: string
  readonly enabled: boolean
  readonly disabledReason?: string
  readonly execute: () => void
}

export type ApplicationCommandRegistry = ReadonlyMap<ApplicationCommandId, ApplicationCommand>

const MAC_GLYPHS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Control: "⌃",
  Escape: "Esc",
}

export function formatApplicationHotkey(hotkey: string, isMac: boolean): string {
  const parts = hotkey.split("+")
  if (isMac) return parts.map((part) => MAC_GLYPHS[part] ?? part).join("")
  return parts.map((part) => (part === "Mod" ? "Ctrl" : part === "Escape" ? "Esc" : part)).join("+")
}

export function applicationAriaHotkey(hotkey: string, isMac: boolean): string {
  return hotkey
    .split("+")
    .map((part) => (part === "Mod" ? (isMac ? "Meta" : "Control") : part))
    .join("+")
}

export function runApplicationCommand(command: ApplicationCommand | undefined): boolean {
  if (command === undefined || !command.enabled) return false
  command.execute()
  return true
}
