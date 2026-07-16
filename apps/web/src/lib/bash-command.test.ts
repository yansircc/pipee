import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import { appendLiveBashOutput, MAX_LIVE_BASH_OUTPUT_CHARS, parseBashCommand } from "./bash-command"

test("parses Pi shell commands and context exclusion", () => {
  assert.deepEqual(parseBashCommand("!pwd"), { command: "pwd", excludeFromContext: false })
  assert.deepEqual(parseBashCommand("!! git status "), { command: "git status", excludeFromContext: true })
})

test("only treats a leading bang with a command as shell input", () => {
  assert.equal(parseBashCommand(" !pwd"), null)
  assert.equal(parseBashCommand("hello!"), null)
  assert.equal(parseBashCommand("!   "), null)
  assert.equal(parseBashCommand("!!"), null)
})

test("bounds live output while retaining the newest shell output", () => {
  const output = appendLiveBashOutput("a".repeat(MAX_LIVE_BASH_OUTPUT_CHARS), "tail")
  assert.match(output, /^\[live output limited/)
  assert.match(output, /tail$/)
  assert.ok(output.length < MAX_LIVE_BASH_OUTPUT_CHARS + 100)
})
