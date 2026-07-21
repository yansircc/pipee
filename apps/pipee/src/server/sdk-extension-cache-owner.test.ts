import { describe, expect, it } from "@effect/vitest"
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent"
import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { SdkExtensionCacheOwner } from "./sdk-extension-cache-owner"

describe("SdkExtensionCacheOwner", () => {
  it.effect("reloads exactly when the cwd-bound package fingerprint changes", () =>
    Effect.gen(function* () {
      const owner = yield* SdkExtensionCacheOwner.make
      const events: Array<string> = []
      const run = (fingerprint: string) =>
        owner.withCandidate(
          { cwd: "/repo", packageSetFingerprint: fingerprint },
          Effect.sync(() => ({ fingerprint })),
          (services) => Effect.sync(() => events.push(`reload:${services.fingerprint}`)).pipe(Effect.asVoid),
          (services) => Effect.sync(() => events.push(`use:${services.fingerprint}`)).pipe(Effect.asVoid),
        )

      yield* run("old-bytes")
      yield* run("old-bytes")
      yield* run("new-bytes")

      expect(events).toEqual([
        "reload:old-bytes",
        "use:old-bytes",
        "use:old-bytes",
        "reload:new-bytes",
        "use:new-bytes",
      ])
    }),
  )

  it.effect("does not commit a token whose reload failed", () =>
    Effect.gen(function* () {
      const owner = yield* SdkExtensionCacheOwner.make
      let reloads = 0
      const token = { cwd: "/repo", packageSetFingerprint: "candidate" }
      const run = (fail: boolean) =>
        owner.withCandidate(
          token,
          Effect.succeed(undefined),
          () =>
            Effect.sync(() => {
              reloads += 1
              if (fail) throw new Error("reload failed")
            }),
          () => Effect.void,
        )

      yield* Effect.exit(run(true))
      yield* run(false)
      expect(reloads).toBe(2)
    }),
  )

  it.effect("serializes cache mutation through session construction", () =>
    Effect.gen(function* () {
      const owner = yield* SdkExtensionCacheOwner.make
      const releaseFirst = yield* Deferred.make<void>()
      const firstStarted = yield* Deferred.make<void>()
      const events: Array<string> = []
      const run = (fingerprint: string, block: boolean) =>
        owner.withCandidate(
          { cwd: "/repo", packageSetFingerprint: fingerprint },
          Effect.succeed(undefined),
          () => Effect.sync(() => events.push(`reload:${fingerprint}`)).pipe(Effect.asVoid),
          () =>
            Effect.gen(function* () {
              events.push(`use:${fingerprint}`)
              if (block) {
                yield* Deferred.succeed(firstStarted, undefined)
                yield* Deferred.await(releaseFirst)
              }
            }),
        )

      const first = yield* Effect.forkChild(run("one", true))
      yield* Deferred.await(firstStarted)
      const second = yield* Effect.forkChild(run("two", false))
      yield* Effect.yieldNow
      expect(events).toEqual(["reload:one", "use:one"])
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(events).toEqual(["reload:one", "use:one", "reload:two", "use:two"])
    }),
  )

  it.effect("reloads a changed extension factory from the same installed path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pipee-extension-cache-" })
        const agentDir = path.join(root, "agent")
        const extensionPath = path.join(root, "extension.ts")
        yield* fs.makeDirectory(agentDir, { recursive: true })
        const source = (toolName: string) => `
          export default function (pi) {
            pi.registerTool({
              name: ${JSON.stringify(toolName)},
              label: ${JSON.stringify(toolName)},
              description: "cache regression fixture",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} })
            })
          }
        `
        const owner = yield* SdkExtensionCacheOwner.make
        const loadTools = (fingerprint: string) =>
          owner.withCandidate(
            { cwd: root, packageSetFingerprint: fingerprint },
            Effect.tryPromise(() =>
              createAgentSessionServices({
                cwd: root,
                agentDir,
                resourceLoaderOptions: {
                  additionalExtensionPaths: [extensionPath],
                  noSkills: true,
                  noPromptTemplates: true,
                  noThemes: true,
                },
              }),
            ),
            (services) => Effect.tryPromise(() => services.resourceLoader.reload()),
            (services) =>
              Effect.sync(() =>
                services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
              ),
          )

        yield* fs.writeFileString(extensionPath, source("old_factory_tool"))
        expect(yield* loadTools("old-bytes")).toEqual(["old_factory_tool"])
        yield* fs.writeFileString(extensionPath, source("new_factory_tool"))
        expect(yield* loadTools("new-bytes")).toEqual(["new_factory_tool"])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
