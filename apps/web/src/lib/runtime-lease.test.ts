import { expect, test } from "vite-plus/test"
import { hasRuntimeLease } from "./runtime-lease"

test("accepts only the canonical runtime lease projection", () => {
  expect(
    hasRuntimeLease([
      {
        _tag: "Structured",
        key: "pi-loop/runtime-lease",
        kind: "pi/runtime-lease",
        version: 1,
        value: { kind: "pi/runtime-lease", version: 1, owner: "pi-loop", reason: "automation-present" },
      },
    ]),
  ).toBe(true)
  expect(
    hasRuntimeLease([
      {
        _tag: "Structured",
        key: "another-extension/runtime-lease",
        kind: "pi/runtime-lease",
        version: 2,
        value: { kind: "pi/runtime-lease", version: 2, owner: "pi-loop", reason: "scheduled-work" },
      },
    ]),
  ).toBe(false)
  expect(hasRuntimeLease([{ _tag: "Text", key: "pi-loop/runtime-lease", text: "active" }])).toBe(false)
})
