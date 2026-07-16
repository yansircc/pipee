import { useCallback, useEffect, useRef } from "react"
import type { Effect } from "effect"
import { runApi } from "./api-client"
import { makeEffectScopeLifecycle } from "./effect-scope-lifecycle"
import type { BrowserServices, Cancel, RuntimeCallbacks } from "./runtime"

interface OwnedRun {
  cancel: Cancel
}

export const useBrowserEffectScope = (owner: string) => {
  const runs = useRef(new Set<OwnedRun>())
  const lifecycleRef = useRef<ReturnType<typeof makeEffectScopeLifecycle> | null>(null)
  if (lifecycleRef.current === null) lifecycleRef.current = makeEffectScopeLifecycle()
  const lifecycle = lifecycleRef.current

  useEffect(() => {
    const epoch = lifecycle.mount(owner)
    const ownedRuns = runs.current
    return () => {
      lifecycle.unmount(epoch)
      const active = [...ownedRuns]
      ownedRuns.clear()
      for (const run of active) run.cancel()
    }
  }, [lifecycle, owner])

  return useCallback(
    <A, E, R extends BrowserServices>(effect: Effect.Effect<A, E, R>, callbacks: RuntimeCallbacks<A>): Cancel => {
      const epoch = lifecycle.current(owner)
      if (epoch === null) return () => undefined
      const owned: OwnedRun = { cancel: () => undefined }
      const release = () => runs.current.delete(owned)
      runs.current.add(owned)
      owned.cancel = runApi(effect, {
        onSuccess: (value) => {
          release()
          if (!lifecycle.owns(epoch, owner)) return
          callbacks.onSuccess(value)
        },
        onFailure: (error) => {
          release()
          if (!lifecycle.owns(epoch, owner)) return
          callbacks.onFailure?.(error)
        },
      })

      // A synchronous Effect may complete before runApi returns.
      if (!runs.current.has(owned)) owned.cancel()

      return () => {
        if (!release()) return
        owned.cancel()
      }
    },
    [lifecycle, owner],
  )
}
