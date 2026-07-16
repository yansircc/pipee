import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  classifyRegistryLookup,
  publicationDecision,
  requireRegistryIntegrity,
} from "./registry-state.mjs"

const integrity = `sha512-${Buffer.from("candidate").toString("base64")}`

describe("registry publication state", () => {
  it("publishes only after an authoritative 404", () => {
    const lookup = classifyRegistryLookup({ status: 1, stderr: "npm error code E404" })
    assert.deepEqual(lookup, { _tag: "Missing" })
    assert.deepEqual(publicationDecision(lookup, integrity), { _tag: "Publish" })
  })

  it("fails closed on registry transport and server errors", () => {
    assert.throws(
      () => classifyRegistryLookup({ status: 1, stderr: "npm error code E500 registry unavailable" }),
      /lookup failed/,
    )
  })

  it("reuses only exact integrity and rejects mismatched bytes", () => {
    const exact = classifyRegistryLookup({ status: 0, stdout: JSON.stringify(integrity) })
    assert.deepEqual(publicationDecision(exact, integrity), { _tag: "Reuse" })
    assert.throws(() => publicationDecision(exact, `${integrity}-different`), /different bytes/)
  })

  it("requires positive equality after publish instead of treating 404 as propagation", () => {
    assert.throws(() => requireRegistryIntegrity({ _tag: "Missing" }, integrity), /not publicly visible/)
    assert.throws(
      () => requireRegistryIntegrity({ _tag: "Present", integrity: `${integrity}-different` }, integrity),
      /mismatch/,
    )
    assert.doesNotThrow(() => requireRegistryIntegrity({ _tag: "Present", integrity }, integrity))
  })
})
