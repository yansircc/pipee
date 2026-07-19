import type { WebSurfaceProjection, WebSurfaceRuntimeIdentity } from "@pi-suite/companion-contracts/web-surface"

export interface WebSurfaceSessionChannelState {
  readonly runtime: WebSurfaceRuntimeIdentity
  readonly revision: number
  readonly initialized: boolean
}

export interface WebSurfaceSessionChannelTransition {
  readonly state: WebSurfaceSessionChannelState
  readonly closeReason?: "runtime-replaced" | "surface-unavailable"
  readonly delivery?: "init" | "projection"
}

const sameRuntime = (left: WebSurfaceRuntimeIdentity, right: WebSurfaceRuntimeIdentity) =>
  left.registryId === right.registryId && left.runtimeEpoch === right.runtimeEpoch && left.runtimeId === right.runtimeId

export const advanceWebSurfaceSessionChannel = (
  previous: WebSurfaceSessionChannelState | undefined,
  runtime: WebSurfaceRuntimeIdentity,
  surface: WebSurfaceProjection | undefined,
): WebSurfaceSessionChannelTransition => {
  const replaced = previous !== undefined && !sameRuntime(previous.runtime, runtime)
  const current = replaced ? undefined : previous
  if (surface === undefined) {
    return {
      state: { runtime, revision: -1, initialized: false },
      ...(replaced
        ? { closeReason: "runtime-replaced" as const }
        : current?.initialized
          ? { closeReason: "surface-unavailable" as const }
          : {}),
    }
  }
  if (current !== undefined && surface.revision <= current.revision) {
    return { state: current }
  }
  return {
    state: { runtime, revision: surface.revision, initialized: true },
    ...(replaced ? { closeReason: "runtime-replaced" as const } : {}),
    delivery: current?.initialized ? "projection" : "init",
  }
}
