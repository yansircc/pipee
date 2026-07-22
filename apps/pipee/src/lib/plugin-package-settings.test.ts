import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  isDisabledPackage,
  isLocalPackageSource,
  removeConfiguredPackage,
  setConfiguredPackageDisabled,
} from "./plugin-package-settings"

const source = "../../code/52/pi-chrome/package"

test("enables and disables the exact configured source without resolving it against cwd", () => {
  const disabled = setConfiguredPackageDisabled([source, "../another-package"], source, true)
  assert.equal(disabled.changed, true)
  assert.equal(isDisabledPackage(disabled.packages[0]), true)
  assert.equal(disabled.packages[1], "../another-package")

  const enabled = setConfiguredPackageDisabled(disabled.packages, source, false)
  assert.deepEqual(enabled, { changed: true, packages: [source, "../another-package"] })
})

test("enabling removes only the package-wide disable filters", () => {
  const enabled = setConfiguredPackageDisabled(
    [
      {
        source,
        autoload: false,
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      },
    ],
    source,
    false,
  )

  assert.deepEqual(enabled.packages, [{ source, autoload: false }])
})

test("removes the exact configured source without resolving it against cwd", () => {
  assert.deepEqual(
    removeConfiguredPackage(
      [{ source, extensions: [], skills: [], prompts: [], themes: [] }, "npm:@yansircc/pi-chrome"],
      source,
    ),
    { changed: true, packages: ["npm:@yansircc/pi-chrome"] },
  )
})

test("classifies only registry and remote package schemes as non-local", () => {
  assert.equal(isLocalPackageSource(source), true)
  assert.equal(isLocalPackageSource("/absolute/package"), true)
  assert.equal(isLocalPackageSource("npm:@scope/package"), false)
  assert.equal(isLocalPackageSource("git:https://github.com/user/repo"), false)
  assert.equal(isLocalPackageSource("https://github.com/user/repo"), false)
})
