import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { Effect } from "effect"
import { runBrowser } from "./api-client"
import {
  BrowserPreferences,
  browserPreferencesRef,
  defaultBrowserPreferences,
  type BrowserPreferencesState,
} from "./preferences"
import { observeMobileViewport } from "./viewport"

interface BrowserPreferencesContextValue {
  readonly preferences: BrowserPreferencesState
  readonly updatePreferences: (transform: (current: BrowserPreferencesState) => BrowserPreferencesState) => void
}

const BrowserPreferencesContext = createContext<BrowserPreferencesContextValue>({
  preferences: defaultBrowserPreferences,
  updatePreferences: () => undefined,
})

const subscribe = (listener: () => void) => browserPreferencesRef.subscribe(listener)
const snapshot = () => browserPreferencesRef.value

export function BrowserPreferencesProvider({ children }: Readonly<{ children: ReactNode }>) {
  const preferences = useSyncExternalStore(subscribe, snapshot, () => defaultBrowserPreferences)

  useEffect(
    () =>
      runBrowser(
        Effect.all([BrowserPreferences.pipe(Effect.flatMap((service) => service.initialize)), observeMobileViewport], {
          concurrency: "unbounded",
          discard: true,
        }),
        { onSuccess: () => undefined },
      ),
    [],
  )

  const updatePreferences = useCallback((transform: (current: BrowserPreferencesState) => BrowserPreferencesState) => {
    runBrowser(BrowserPreferences.pipe(Effect.flatMap((service) => service.update(transform))), {
      onSuccess: () => undefined,
    })
  }, [])

  const value = useMemo(() => ({ preferences, updatePreferences }), [preferences, updatePreferences])
  return <BrowserPreferencesContext.Provider value={value}>{children}</BrowserPreferencesContext.Provider>
}

export const useBrowserPreferences = (): BrowserPreferencesContextValue => useContext(BrowserPreferencesContext)
