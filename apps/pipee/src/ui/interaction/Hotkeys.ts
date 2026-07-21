import { useHotkeys, type UseHotkeyDefinition } from "@tanstack/react-hotkeys"
import type { ApplicationCommand } from "./ApplicationCommands"

export function dispatchApplicationHotkey(command: ApplicationCommand, event: KeyboardEvent): boolean {
  if (event.isComposing || !command.enabled || (command.id === "app.cancel" && event.defaultPrevented)) return false
  event.preventDefault()
  event.stopPropagation()
  command.execute()
  return true
}

export function resolveApplicationHotkey(hotkey: string, isMac: boolean): string {
  return hotkey
    .split("+")
    .map((part) => (part === "Mod" ? (isMac ? "Meta" : "Control") : part))
    .join("+")
}

/**
 * The single application boundary for global shortcuts. Components provide
 * commands; TanStack Hotkeys owns platform matching, registration and cleanup.
 */
export function useApplicationHotkeys(commands: ReadonlyArray<ApplicationCommand>, isMac: boolean) {
  useHotkeys(
    commands.flatMap((command) =>
      command.hotkey === undefined
        ? []
        : [
            {
              hotkey: resolveApplicationHotkey(command.hotkey, isMac) as UseHotkeyDefinition["hotkey"],
              callback: (event: KeyboardEvent) => dispatchApplicationHotkey(command, event),
              options: {
                enabled: command.enabled,
                ignoreInputs: false,
                preventDefault: false,
                stopPropagation: false,
              },
            },
          ],
    ),
    { eventType: "keydown", platform: isMac ? "mac" : "linux" },
  )
}

export function ApplicationHotkeys({
  commands,
  isMac,
}: {
  readonly commands: ReadonlyArray<ApplicationCommand>
  readonly isMac: boolean
}) {
  useApplicationHotkeys(commands, isMac)
  return null
}
