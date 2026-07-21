import { it } from "@effect/vitest"
import { Effect } from "effect"
import { expect } from "vite-plus/test"
import { formatModelsConfigJson, parseModelsConfigJson } from "./models-config-json"

it.effect("round-trips every Pi models.json field owned by the contract", () => {
  const source = JSON.stringify({
    providers: {
      custom: {
        name: "Custom",
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        apiKey: "$CUSTOM_KEY",
        authHeader: true,
        headers: { "x-source": "pipee" },
        models: [
          {
            id: "model-1",
            baseUrl: "https://model.example.test/v1",
            input: ["text", "image"],
            headers: { "x-model": "one" },
            cost: {
              input: 1,
              output: 2,
              cacheRead: 0.1,
              cacheWrite: 0.2,
              tiers: [{ inputTokensAbove: 100_000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }],
            },
          },
        ],
        modelOverrides: {
          builtIn: { headers: { "x-route": "custom" }, cost: { input: 3 } },
        },
      },
    },
  })

  return Effect.gen(function* () {
    const decoded = yield* parseModelsConfigJson(source)
    const formatted = yield* formatModelsConfigJson(decoded)
    expect(JSON.parse(formatted)).toEqual(JSON.parse(source))
  })
})

it.effect("rejects malformed JSON and structurally invalid model configs", () =>
  Effect.gen(function* () {
    const malformed = yield* Effect.flip(parseModelsConfigJson("{not-json"))
    expect(malformed.operation).toBe("parse")
    expect(malformed.message).toMatch(/JSON/)

    const invalidModel = yield* Effect.flip(parseModelsConfigJson('{"providers":{"custom":{"models":[{"id":1}]}}}'))
    expect(invalidModel.operation).toBe("decode")

    const missingProviders = yield* Effect.flip(parseModelsConfigJson("{}"))
    expect(missingProviders.operation).toBe("decode")
  }),
)
