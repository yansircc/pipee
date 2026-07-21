import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

describe("package update facts", () => {
  it.effect("reports only a floating npm source whose resolved version is newer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "pipee-update-check-" })
        const agentDir = path.join(root, "agent")
        const npmFixture = path.join(root, "npm-fixture.mjs")
        yield* fs.writeFileString(
          npmFixture,
          `
            const spec = process.argv[process.argv.indexOf("view") + 1] ?? ""
            if (spec.includes("failure")) process.exit(1)
            process.stdout.write(JSON.stringify(spec.includes("newer") ? "1.1.0" : "1.0.0"))
          `,
        )
        const sources = [
          "npm:@fixture/current@latest",
          "npm:@fixture/newer@latest",
          "npm:@fixture/pinned@1.0.0",
          "npm:@fixture/failure@latest",
        ]
        for (const source of ["current", "newer", "pinned", "failure"]) {
          const directory = path.join(agentDir, "npm", "node_modules", "@fixture", source)
          yield* fs.makeDirectory(directory, { recursive: true })
          yield* fs.writeFileString(
            path.join(directory, "package.json"),
            JSON.stringify({ name: `@fixture/${source}`, version: "1.0.0" }),
          )
        }
        const settings = SettingsManager.inMemory({
          packages: sources,
          npmCommand: [process.execPath, npmFixture],
        })
        const manager = new DefaultPackageManager({ cwd: root, agentDir, settingsManager: settings })
        const updates = yield* Effect.promise(() => manager.checkForAvailableUpdates())

        expect(updates).toEqual([
          {
            source: "npm:@fixture/newer@latest",
            displayName: "@fixture/newer",
            type: "npm",
            scope: "user",
          },
        ])
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  )
})
