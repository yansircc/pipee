import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { elapsedDuration, formatDuration } from "./duration"

test("formats elapsed time with one stable unit ladder", () => {
  assert.equal(formatDuration(0), "0ms")
  assert.equal(formatDuration(999), "999ms")
  assert.equal(formatDuration(1_000), "1s")
  assert.equal(formatDuration(12_345), "12.3s")
  assert.equal(formatDuration(60_000), "1min")
  assert.equal(formatDuration(125_000), "2min 5s")
  assert.equal(formatDuration(3_720_000), "1h 2min")
  assert.equal(formatDuration(93_600_000), "1day 2h")
})

test("derives only monotonic elapsed durations", () => {
  assert.equal(elapsedDuration(1_000, 1_750), 750)
  assert.equal(elapsedDuration(undefined, 1_750), null)
  assert.equal(elapsedDuration(2_000, 1_750), null)
})
