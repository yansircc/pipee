import { it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect } from "vite-plus/test"
import { BrowserPreferences, browserPreferencesRef, defaultBrowserPreferences } from "@/browser/preferences"
import { clearDraft, getDraft, setDraft } from "./draft-store"

const BrowserPreferencesTest = Layer.succeed(BrowserPreferences, {
  initialize: Effect.void,
  update: (transform) =>
    Effect.sync(() => {
      browserPreferencesRef.set(transform(browserPreferencesRef.value))
    }),
})

const isolated = <A, E>(effect: Effect.Effect<A, E, BrowserPreferences>) =>
  Effect.sync(() => {
    browserPreferencesRef.set(defaultBrowserPreferences)
  }).pipe(
    Effect.andThen(effect),
    Effect.ensuring(Effect.sync(() => browserPreferencesRef.set(defaultBrowserPreferences))),
    Effect.provide(BrowserPreferencesTest),
  )

it.effect("keeps path attachments with their draft", () =>
  isolated(
    Effect.gen(function* () {
      const key = "attachment-draft"
      yield* setDraft(key, {
        value: "inspect this",
        images: [],
        attachments: [
          {
            path: "/tmp/report.xlsx",
            name: "report.xlsx",
            size: 42,
            mimeType: "application/octet-stream",
            managed: false,
          },
        ],
      })
      expect(getDraft(key)?.attachments.map((item) => item.path)).toEqual(["/tmp/report.xlsx"])
      yield* clearDraft(key)
      expect(getDraft(key)).toBeNull()
    }),
  ),
)

it.effect("does not discard an attachment-only draft", () =>
  isolated(
    Effect.gen(function* () {
      const key = "attachment-only"
      yield* setDraft(key, {
        value: "",
        images: [],
        attachments: [
          {
            path: "/tmp/archive.zip",
            name: "archive.zip",
            size: 8,
            mimeType: "application/zip",
            managed: true,
          },
        ],
      })
      expect(getDraft(key)?.attachments).toHaveLength(1)
      yield* clearDraft(key)
    }),
  ),
)
