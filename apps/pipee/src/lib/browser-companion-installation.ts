import {
  BrowserCompanionProbeResponse,
  BrowserCompanionWakeResponse,
  browserCompanionMismatches,
  browserCompanionProbeRequest,
  browserCompanionWakeRequest,
  type BrowserCompanionExpectation,
  type BrowserCompanionProbe,
} from "@pipee/companion-contracts/browser-companion"
import { Effect, Schema } from "effect"
import { BrowserPlatform } from "@/browser/browser-platform"

export const probeBrowserCompanion = (
  expected: BrowserCompanionExpectation,
): Effect.Effect<BrowserCompanionProbe, never, BrowserPlatform> =>
  BrowserPlatform.pipe(
    Effect.flatMap((browser) => browser.sendChromeExtensionMessage(expected.extensionId, browserCompanionProbeRequest)),
    Effect.flatMap(Schema.decodeUnknownEffect(BrowserCompanionProbeResponse)),
    Effect.map((response): BrowserCompanionProbe => {
      const mismatches = browserCompanionMismatches(expected, response.extension)
      return mismatches.length === 0
        ? { _tag: "Compatible", expected, actual: response.extension }
        : { _tag: "Incompatible", expected, actual: response.extension, mismatches }
    }),
    Effect.orElseSucceed((): BrowserCompanionProbe => ({ _tag: "Missing", expected })),
  )

export const wakeBrowserCompanion = (
  expected: BrowserCompanionExpectation,
): Effect.Effect<boolean, never, BrowserPlatform> =>
  BrowserPlatform.pipe(
    Effect.flatMap((browser) => browser.sendChromeExtensionMessage(expected.extensionId, browserCompanionWakeRequest)),
    Effect.flatMap(Schema.decodeUnknownEffect(BrowserCompanionWakeResponse)),
    Effect.map((response) => response.accepted),
    Effect.orElseSucceed(() => false),
  )
