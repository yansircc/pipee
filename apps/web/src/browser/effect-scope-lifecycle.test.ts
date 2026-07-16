import { describe, expect, it } from "vite-plus/test"
import { makeEffectScopeLifecycle } from "./effect-scope-lifecycle"

describe("Effect scope lifecycle", () => {
  it("revokes callbacks from every prior mount epoch", () => {
    const lifecycle = makeEffectScopeLifecycle()
    const first = lifecycle.mount("session:first")
    expect(lifecycle.owns(first, "session:first")).toBe(true)

    lifecycle.unmount(first)
    expect(lifecycle.owns(first, "session:first")).toBe(false)

    const second = lifecycle.mount("session:second")
    expect(lifecycle.owns(first, "session:first")).toBe(false)
    expect(lifecycle.owns(second, "session:second")).toBe(true)
  })

  it("does not let stale cleanup revoke the active epoch", () => {
    const lifecycle = makeEffectScopeLifecycle()
    const first = lifecycle.mount("session:first")
    const second = lifecycle.mount("session:second")

    lifecycle.unmount(first)
    expect(lifecycle.current("session:second")).toBe(second)
  })

  it("rejects callbacks whose session owner is no longer active", () => {
    const lifecycle = makeEffectScopeLifecycle()
    const first = lifecycle.mount("session:first")

    expect(lifecycle.current("session:second")).toBe(null)
    expect(lifecycle.owns(first, "session:second")).toBe(false)
  })
})
