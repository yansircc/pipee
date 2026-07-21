import { useCallback } from "react"
import { useBrowserPreferences } from "@/browser/preferences-react"

type ToggleOrigin = { readonly x: number; readonly y: number }

export function useTheme() {
  const { preferences, updatePreferences } = useBrowserPreferences()
  const theme = preferences.theme

  const toggleTheme = useCallback(
    (_origin?: ToggleOrigin) => {
      updatePreferences((current) => ({
        ...current,
        theme: current.theme === "dark" ? "light" : "dark",
      }))
    },
    [updatePreferences],
  )

  return { theme, toggleTheme, isDark: theme === "dark" }
}
