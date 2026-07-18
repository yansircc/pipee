import { describe, expect, it } from "vite-plus/test"
import type { PluginPackageInfo } from "@/api/contract"
import {
  chromeExtensionExpectation,
  chromeExtensionNeedsAttention,
  type ChromeExtensionHealth,
} from "./chrome-extension-installation"

const packageInfo = (overrides: Partial<PluginPackageInfo> = {}): PluginPackageInfo => ({
  source: "npm:@yansircc/pi-chrome",
  scope: "global",
  filtered: false,
  disabled: false,
  packageName: "@yansircc/pi-chrome",
  version: "0.3.0",
  chromeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  chromeExtensionDisplayVersion: "0.3.0",
  chromeProtocolFingerprint: "f".repeat(64),
  counts: { extensions: 1, skills: 0, prompts: 0, themes: 0 },
  resources: [],
  status: "loaded",
  ...overrides,
})

describe("Chrome extension installation projection", () => {
  it("derives the browser expectation only from the global pi-chrome package evidence", () => {
    expect(chromeExtensionExpectation(packageInfo())).toEqual({
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      displayVersion: "0.3.0",
      protocolFingerprint: "f".repeat(64),
    })
    expect(chromeExtensionExpectation(packageInfo({ scope: "project" }))).toBeNull()
    expect(chromeExtensionExpectation(packageInfo({ disabled: true }))).toBeNull()
    expect(chromeExtensionExpectation(packageInfo({ chromeProtocolFingerprint: undefined }))).toBeNull()
  })

  it.each([
    [{ _tag: "Missing", expected: chromeExtensionExpectation(packageInfo())! }, true],
    [
      {
        _tag: "Incompatible",
        expected: chromeExtensionExpectation(packageInfo())!,
        actual: chromeExtensionExpectation(packageInfo({ chromeExtensionDisplayVersion: "0.2.0" }))!,
        mismatches: ["DisplayVersion"],
      },
      true,
    ],
    [{ _tag: "Ready", extension: chromeExtensionExpectation(packageInfo())! }, false],
    [{ _tag: "NotInstalled" }, false],
  ] satisfies ReadonlyArray<readonly [ChromeExtensionHealth, boolean]>)(
    "maps %s to attention=%s",
    (health, expected) => {
      expect(chromeExtensionNeedsAttention(health)).toBe(expected)
    },
  )
})
