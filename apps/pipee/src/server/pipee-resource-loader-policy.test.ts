import { describe, expect, it } from "@effect/vitest"
import { createAgentSessionServices, DefaultResourceLoader } from "@earendil-works/pi-coding-agent"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path } from "effect"
import { pipeeResourceLoaderPolicy } from "./pipee-resource-loader-policy"

describe("Pipee resource-loader policy", () => {
  it.effect("keeps runtime and management discovery closed to ambient skills", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pipee-skill-policy-" })
        const agentDir = path.join(root, "agent")
        yield* fs.makeDirectory(agentDir, { recursive: true })

        const management = new DefaultResourceLoader({ cwd: root, agentDir, ...pipeeResourceLoaderPolicy() })
        const runtime = yield* Effect.tryPromise(() =>
          createAgentSessionServices({ cwd: root, agentDir, resourceLoaderOptions: pipeeResourceLoaderPolicy() }),
        )
        yield* Effect.tryPromise(() => Promise.all([management.reload(), runtime.resourceLoader.reload()]))

        expect(management.getSkills().skills).toEqual([])
        expect(runtime.resourceLoader.getSkills().skills).toEqual([])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("loads only an explicitly authorized skill in both surfaces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pipee-explicit-skill-" })
        const agentDir = path.join(root, "agent")
        const skillDir = path.join(root, "authorized")
        const skillFile = path.join(skillDir, "SKILL.md")
        yield* fs.makeDirectory(agentDir, { recursive: true })
        yield* fs.makeDirectory(skillDir, { recursive: true })
        yield* fs.writeFileString(
          skillFile,
          "---\nname: authorized\ndescription: Explicit Pipee skill\n---\n\n# Authorized\n",
        )
        const policy = pipeeResourceLoaderPolicy([skillFile])
        const management = new DefaultResourceLoader({ cwd: root, agentDir, ...policy })
        const runtime = yield* Effect.tryPromise(() =>
          createAgentSessionServices({ cwd: root, agentDir, resourceLoaderOptions: policy }),
        )
        yield* Effect.tryPromise(() => Promise.all([management.reload(), runtime.resourceLoader.reload()]))

        expect(management.getSkills().skills.map((skill) => skill.name)).toEqual(["authorized"])
        expect(runtime.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["authorized"])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
