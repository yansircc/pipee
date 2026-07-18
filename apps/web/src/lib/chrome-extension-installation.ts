import {
  ChromeExtensionProbeResponse,
  chromeExtensionMismatches,
  chromeExtensionProbeRequest,
  type ChromeExtensionExpectation,
} from "@pi-suite/companion-contracts/chrome"
import { Effect, Schema } from "effect"
import type { PluginPackageInfo } from "@/api/contract"
import { BrowserPlatform } from "@/browser/browser-platform"
import { PI_COMPANION_PACKAGE_NAMES } from "./plugin-package-settings"

export type ChromeExtensionHealth =
  | { readonly _tag: "NotInstalled" }
  | { readonly _tag: "Missing"; readonly expected: ChromeExtensionExpectation }
  | {
      readonly _tag: "Incompatible"
      readonly expected: ChromeExtensionExpectation
      readonly actual: ChromeExtensionExpectation
      readonly mismatches: ReadonlyArray<"ExtensionId" | "DisplayVersion" | "ProtocolFingerprint">
    }
  | { readonly _tag: "Ready"; readonly extension: ChromeExtensionExpectation }

export const chromeExtensionExpectation = (pkg: PluginPackageInfo | null): ChromeExtensionExpectation | null =>
  pkg?.scope === "global" &&
  pkg.packageName === PI_COMPANION_PACKAGE_NAMES.chrome &&
  !pkg.disabled &&
  pkg.chromeExtensionId !== undefined &&
  pkg.chromeExtensionDisplayVersion !== undefined &&
  pkg.chromeProtocolFingerprint !== undefined
    ? {
        extensionId: pkg.chromeExtensionId,
        displayVersion: pkg.chromeExtensionDisplayVersion,
        protocolFingerprint: pkg.chromeProtocolFingerprint,
      }
    : null

export const probeChromeExtension = (
  pkg: PluginPackageInfo | null,
): Effect.Effect<ChromeExtensionHealth, never, BrowserPlatform> => {
  const expected = chromeExtensionExpectation(pkg)
  if (expected === null) return Effect.succeed({ _tag: "NotInstalled" })
  return BrowserPlatform.pipe(
    Effect.flatMap((browser) => browser.sendChromeExtensionMessage(expected.extensionId, chromeExtensionProbeRequest)),
    Effect.flatMap(Schema.decodeUnknownEffect(ChromeExtensionProbeResponse)),
    Effect.map((response): ChromeExtensionHealth => {
      const mismatches = chromeExtensionMismatches(expected, response.extension)
      return mismatches.length === 0
        ? { _tag: "Ready", extension: response.extension }
        : { _tag: "Incompatible", expected, actual: response.extension, mismatches }
    }),
    Effect.catch(() => Effect.succeed<ChromeExtensionHealth>({ _tag: "Missing", expected })),
  )
}

export const chromeExtensionNeedsAttention = (health: ChromeExtensionHealth): boolean =>
  health._tag === "Missing" || health._tag === "Incompatible"
