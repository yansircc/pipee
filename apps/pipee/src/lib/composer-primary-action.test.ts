import { describe, expect, it } from "vitest"
import { resolveStreamingPrimaryAction } from "./composer-primary-action"

describe("resolveStreamingPrimaryAction", () => {
  it("uses one primary control whose meaning follows the draft and runtime capabilities", () => {
    expect(resolveStreamingPrimaryAction({ hasDraft: false, canFollowUp: true, canSteer: true })).toBe("stop")
    expect(resolveStreamingPrimaryAction({ hasDraft: true, canFollowUp: true, canSteer: true })).toBe("followup")
    expect(resolveStreamingPrimaryAction({ hasDraft: true, canFollowUp: false, canSteer: true })).toBe("steer")
    expect(resolveStreamingPrimaryAction({ hasDraft: true, canFollowUp: false, canSteer: false })).toBe("stop")
  })
})
