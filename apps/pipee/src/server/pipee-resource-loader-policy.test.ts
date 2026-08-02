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

        const policy = pipeeResourceLoaderPolicy(path, root, agentDir)
        const management = new DefaultResourceLoader({ cwd: root, agentDir, ...policy })
        const runtime = yield* Effect.tryPromise(() =>
          createAgentSessionServices({ cwd: root, agentDir, resourceLoaderOptions: policy }),
        )
        yield* Effect.tryPromise(() => Promise.all([management.reload(), runtime.resourceLoader.reload()]))

        expect(management.getSkills().skills).toEqual([])
        expect(runtime.resourceLoader.getSkills().skills).toEqual([])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("loads only Pi-native skill roots in both surfaces", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pipee-explicit-skill-" })
        const agentDir = path.join(root, "agent")
        const globalSkillFile = path.join(agentDir, "skills", "global", "SKILL.md")
        const projectSkillFile = path.join(root, ".pi", "skills", "project", "SKILL.md")
        const ambientSkillFile = path.join(root, ".agents", "skills", "ambient", "SKILL.md")
        yield* fs.makeDirectory(agentDir, { recursive: true })
        yield* fs.makeDirectory(path.dirname(globalSkillFile), { recursive: true })
        yield* fs.makeDirectory(path.dirname(projectSkillFile), { recursive: true })
        yield* fs.makeDirectory(path.dirname(ambientSkillFile), { recursive: true })
        yield* fs.writeFileString(globalSkillFile, "---\nname: global\ndescription: Pi global skill\n---\n\n# Global\n")
        yield* fs.writeFileString(
          projectSkillFile,
          "---\nname: project\ndescription: Pi project skill\n---\n\n# Project\n",
        )
        yield* fs.writeFileString(
          ambientSkillFile,
          "---\nname: ambient\ndescription: Ambient agent projection\n---\n\n# Ambient\n",
        )
        const policy = pipeeResourceLoaderPolicy(path, root, agentDir)
        const management = new DefaultResourceLoader({ cwd: root, agentDir, ...policy })
        const runtime = yield* Effect.tryPromise(() =>
          createAgentSessionServices({ cwd: root, agentDir, resourceLoaderOptions: policy }),
        )
        yield* Effect.tryPromise(() => Promise.all([management.reload(), runtime.resourceLoader.reload()]))

        expect(management.getSkills().skills.map((skill) => skill.name)).toEqual(["global", "project"])
        expect(runtime.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["global", "project"])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
