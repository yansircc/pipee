import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import spawn from "cross-spawn"

const root = fileURLToPath(new URL("..", import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), "pi-web-local-package-"))
const run = (command, args) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" })
    child.once("error", rejectPromise)
    child.once("exit", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited ${code}`)),
    )
  })

try {
  await run("pnpm", ["pack", "--pack-destination", temporary])
  const archives = (await readdir(temporary)).filter((file) => file.endsWith(".tgz"))
  if (archives.length !== 1) throw new Error(`expected one local archive, found ${archives.length}`)
  await run(process.execPath, [
    "scripts/test-package.mjs",
    "--consumer",
    "npm",
    "--checks",
    "structure,install,bin,cli,health,page,browser,sse,cleanup,port-release",
    join(temporary, archives[0]),
  ])
  await run(process.execPath, [
    "scripts/test-package.mjs",
    "--consumer",
    "pnpm",
    "--checks",
    "structure,install,bin,cli,health,page,browser,sse,cleanup,port-release",
    join(temporary, archives[0]),
  ])
} finally {
  await rm(temporary, { recursive: true, force: true })
}
