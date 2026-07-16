import { expect, test } from "vite-plus/test"
import { hasRuntimeLease } from "./runtime-lease"

test("accepts only the canonical runtime lease projection", () => {
  expect(
    hasRuntimeLease([
      {
        key: "pi-loop/runtime-lease",
        status: { kind: "pi/runtime-lease", version: 1, owner: "pi-loop", reason: "automation-present" },
      },
    ]),
  ).toBe(true)
  expect(
    hasRuntimeLease([
      {
        key: "another-extension/runtime-lease",
        status: { kind: "pi/runtime-lease", version: 2, owner: "pi-loop", reason: "scheduled-work" },
      },
    ]),
  ).toBe(false)
  expect(hasRuntimeLease([{ key: "pi-loop/runtime-lease", text: "active" }])).toBe(false)
})
