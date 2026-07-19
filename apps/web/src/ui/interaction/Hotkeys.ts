import { useHotkeys, type UseHotkeyDefinition, type UseHotkeyOptions } from "@tanstack/react-hotkeys"

/**
 * The single application boundary for global shortcuts. Components provide
 * commands; TanStack Hotkeys owns platform matching, registration and cleanup.
 */
export function useApplicationHotkeys(hotkeys: ReadonlyArray<UseHotkeyDefinition>, options?: UseHotkeyOptions) {
  useHotkeys([...hotkeys], options)
}
