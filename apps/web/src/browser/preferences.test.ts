import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeBrowserPreferences } from "./preferences"

it.effect("decodes the current browser preferences document", () =>
  Effect.gen(function* () {
    const encoded = JSON.stringify({
      version: 1,
      locale: "zh-CN",
      theme: "dark",
      soundEnabled: true,
      drafts: {},
      unreadSessionIds: [],
    })
    const preferences = yield* decodeBrowserPreferences(encoded)
    expect(preferences).toMatchObject({ version: 1, locale: "zh-CN", theme: "dark" })
  }),
)
