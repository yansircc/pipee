import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs"

const source = "a".repeat(40)

describe("Suite release record", () => {
  it("accepts one canonical record bound to its source parent and manifests", () => {
    const record = parseReleaseRecord(
      `chore(release): suite-v0.6.0\n\nRelease-Source: ${source}\n\nRelease-Bump: minor`,
    )
    assert.deepEqual(record, { version: "0.6.0", source, bump: "minor" })
    assert.deepEqual(
      assertReleaseRecordCommit({ record, parents: [source], manifestVersions: Array(5).fill("0.6.0") }),
      record,
    )
  })

  it("does not classify ordinary source commits", () => {
    assert.equal(parseReleaseRecord("feat: add runtime"), undefined)
    assert.equal(parseReleaseRecord("feat: add runtime\n\nRelease-Bump: minor"), undefined)
  })

  it("rejects forged, partial, and duplicate records", () => {
    assert.throws(() => parseReleaseRecord(`feat: forged\n\nRelease-Source: ${source}`), /non-canonical/)
    assert.throws(
      () =>
        parseReleaseRecord(
          `chore(release): suite-v0.6.0\n\nRelease-Source: ${source}\nRelease-Source: ${"b".repeat(40)}\nRelease-Bump: minor`,
        ),
      /exactly one Release-Source/,
    )
    const record = parseReleaseRecord(
      `chore(release): suite-v0.6.0\n\nRelease-Source: ${source}\n\nRelease-Bump: minor`,
    )
    assert.throws(
      () => assertReleaseRecordCommit({ record, parents: ["b".repeat(40)], manifestVersions: ["0.6.0"] }),
      /only parent/,
    )
    assert.throws(
      () => assertReleaseRecordCommit({ record, parents: [source], manifestVersions: ["0.6.0", "0.5.7"] }),
      /every Suite manifest/,
    )
  })
})
