import { run } from "./lib.mjs"

const gates = [
  ["@yansircc/pi-web", "src/browser/preferences.test.ts"],
  ["@yansircc/pi-loop", "test-suite/repository.test.ts"],
  ["@yansircc/pi-weixin", "test/state.test.ts"],
  ["@yansircc/pi-chrome", "test-suite/unit/connector-binding.test.ts", "test-suite/unit/command-journal.test.ts"],
]

for (const [name, ...tests] of gates) {
  run("pnpm", ["--filter", name, "exec", "vp", "test", ...tests])
}
