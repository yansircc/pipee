import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { WebSurfaceProjection, type WebSurfaceRuntimeIdentity } from "@pipee/companion-contracts/web-surface"
import { advanceWebSurfaceSessionChannel } from "./web-surface-channel-state"

const runtime = (runtimeId: string, runtimeEpoch = 1): WebSurfaceRuntimeIdentity => ({
  registryId: "registry",
  runtimeEpoch,
  runtimeId,
})

const surface = (revision: number) =>
  Schema.decodeUnknownSync(WebSurfaceProjection)({
    packageName: "@yansircc/pi-loop",
    surfaceId: "QHlhbnNpcmNjL3BpLWxvb3A",
    candidateHash: "a".repeat(64),
    revision,
    view: null,
  })

describe("Web Surface Session channel state", () => {
  it("filters stale revisions independently inside one Runtime", () => {
    const initial = advanceWebSurfaceSessionChannel(undefined, runtime("one"), surface(2))
    expect(initial.delivery).toBe("init")
    const stale = advanceWebSurfaceSessionChannel(initial.state, runtime("one"), surface(1))
    expect(stale.delivery).toBeUndefined()
    expect(stale.state.revision).toBe(2)
  })

  it("closes only the replaced binding and initializes its new Runtime", () => {
    const left = advanceWebSurfaceSessionChannel(undefined, runtime("left"), surface(1))
    const right = advanceWebSurfaceSessionChannel(undefined, runtime("right"), surface(7))
    const replaced = advanceWebSurfaceSessionChannel(left.state, runtime("left-next", 2), surface(1))
    expect(replaced).toMatchObject({ closeReason: "runtime-replaced", delivery: "init" })
    expect(right.state).toMatchObject({ runtime: { runtimeId: "right" }, revision: 7, initialized: true })
  })

  it("removes action admission when the surface disappears", () => {
    const initial = advanceWebSurfaceSessionChannel(undefined, runtime("one"), surface(1))
    const removed = advanceWebSurfaceSessionChannel(initial.state, runtime("one"), undefined)
    expect(removed.closeReason).toBe("surface-unavailable")
    expect(removed.state.initialized).toBe(false)
    expect(removed.state.revision).toBe(-1)
  })
})
