import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { it } from "node:test"
import { resolve } from "node:path"
import { root } from "./lib.mjs"

const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8")

it("owns one Linux candidate and same-artifact macOS/Windows witnesses", () => {
  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /candidate:[\s\S]*runs-on: ubuntu-latest/)
  assert.match(workflow, /matrix:[\s\S]*os: \[macos-14, windows-2022\]/)
  assert.match(workflow, /platform-witness:[\s\S]*download-artifact/)
  assert.doesNotMatch(workflow.match(/platform-witness:[\s\S]*?\n  publish:/)?.[0] ?? "", /build-candidates|\bpack\b/)
})

it("keeps OIDC publish and public propagation in separate jobs", () => {
  const publish = workflow.match(/\n  publish:[\s\S]*?\n  public-acceptance:/)?.[0] ?? ""
  const publicAcceptance = workflow.match(/\n  public-acceptance:[\s\S]*$/)?.[0] ?? ""
  assert.match(publish, /id-token: write/)
  assert.match(publish, /npm 11\.5\.1 or newer/)
  assert.match(publish, /pnpm publish:candidates/)
  assert.doesNotMatch(publish, /verify:registry/)
  assert.match(publicAcceptance, /needs: publish/)
  assert.match(publicAcceptance, /pnpm verify:registry/)
  assert.doesNotMatch(publicAcceptance, /publish:candidates/)
  assert.doesNotMatch(workflow, /registry-url:/)
})
