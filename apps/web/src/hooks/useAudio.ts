import { useCallback, useEffect, useRef } from "react"
import { Effect } from "effect"
import { runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { useBrowserPreferences } from "@/browser/preferences-react"

export function useAudio() {
  const { preferences, updatePreferences } = useBrowserPreferences()
  const enabled = preferences.soundEnabled
  const enabledRef = useRef(enabled)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  const unlockAudio = useCallback((force = false) => {
    if (!force && !enabledRef.current) return
    runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.unlockAudio)), { onSuccess: () => undefined })
  }, [])

  const toggle = useCallback(() => {
    if (!enabledRef.current) unlockAudio(true)
    updatePreferences((current) => ({ ...current, soundEnabled: !current.soundEnabled }))
  }, [unlockAudio, updatePreferences])

  const playDone = useCallback(() => {
    if (!enabledRef.current) return
    runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.playDoneSound)), { onSuccess: () => undefined })
  }, [])

  return {
    soundEnabled: enabled,
    onSoundToggle: toggle,
    playDoneSound: playDone,
    unlockAudio,
    soundEnabledRef: enabledRef,
  }
}
