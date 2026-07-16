import { Effect } from "effect"
import { BrowserPlatform } from "@/browser/browser-platform"

export const copyText = (text: string) =>
  BrowserPlatform.pipe(Effect.flatMap((browser) => browser.writeClipboard(text)))
