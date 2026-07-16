import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { decodeBrowserPreferences } from "./preferences"

it.effect("decodes the previous Suite Release browser preferences fixture", () =>
  Effect.gen(function* () {
    const encoded = yield* Effect.promise(() =>
      readFile(
        fileURLToPath(new URL("../../../../tests/upgrade-fixtures/pi-web-preferences-v1.json", import.meta.url)),
        "utf8",
      ),
    )
    const preferences = yield* decodeBrowserPreferences(encoded)
    expect(preferences).toMatchObject({ version: 1, locale: "zh-CN", theme: "dark" })
  }),
)
