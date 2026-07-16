import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import process from "node:process"
import { stripVTControlCharacters } from "node:util"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtureRoot = join(root, "test-results", "e2e-fixture")
const home = join(fixtureRoot, "home")
const workspace = join(fixtureRoot, "workspace")
const operatorHome = process.env.HOME
const operatorUserProfile = process.env.USERPROFILE
const packageManagerEntry = process.env.npm_execpath
if (!packageManagerEntry) throw new Error("start-e2e must run through the repository package manager")
const requestedPort = Number(process.env.PI_WEB_E2E_PORT ?? "30141")
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("PI_WEB_E2E_PORT must be an integer between 1 and 65535")
}
const extensionPath = process.env.PI_WEB_E2E_EXTENSION_PATH
const vitePackageDirectory = dirname(fileURLToPath(import.meta.resolve("vite/package.json")))
const viteCli = join(vitePackageDirectory, "dist", "vite", "node", "cli.js")

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))))
  })

const waitForHealth = async (url) => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {
      // The server has bound its socket but the application graph is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`E2E server did not become healthy at ${url}`)
}

const waitForServerUrl = (server) =>
  new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error("E2E server did not report its bound URL"))
    }, 30_000)
    server.stdout.on("data", (chunk) => {
      process.stdout.write(chunk)
      if (settled) return
      output = `${output}${chunk}`.slice(-8_192)
      const match = stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (!match) return
      settled = true
      clearTimeout(timeout)
      resolve(`http://127.0.0.1:${match[1]}`)
    })
    server.stderr.on("data", (chunk) => process.stderr.write(chunk))
    server.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    server.once("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`E2E server exited before reporting its URL (${code ?? 1})`))
    })
  })

await rm(fixtureRoot, { recursive: true, force: true })
await mkdir(home, { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, "hello.txt"), "hello from the isolated e2e workspace\n")
const fixtureSkillDirectory = join(workspace, ".agents", "skills", "e2e-skill")
await mkdir(fixtureSkillDirectory, { recursive: true })
await writeFile(
  join(fixtureSkillDirectory, "SKILL.md"),
  "---\nname: e2e-skill\ndescription: isolated fixture\n---\n\n# E2E skill\n",
)
const fixturePluginDirectory = join(fixtureRoot, "e2e-plugin")
const fixtureExtensionDirectory = join(fixtureRoot, "e2e-extension")
const fixtureNpmCommandLog = join(fixtureRoot, "npm-command.log")
const fixtureNpmCommand = join(fixtureRoot, "npm-command.mjs")
const fixturePluginSkillDirectory = join(fixturePluginDirectory, "skills", "plugin-skill")
await mkdir(fixturePluginSkillDirectory, { recursive: true })
await writeFile(
  join(fixturePluginDirectory, "package.json"),
  JSON.stringify(
    {
      name: "pi-web-e2e-plugin",
      version: "1.0.0",
      pi: { skills: ["skills/plugin-skill/SKILL.md"] },
    },
    null,
    2,
  ),
)
await writeFile(
  join(fixturePluginSkillDirectory, "SKILL.md"),
  "---\nname: plugin-skill\ndescription: local package fixture\n---\n\n# Plugin skill\n",
)
await mkdir(fixtureExtensionDirectory, { recursive: true })
await writeFile(
  join(fixtureExtensionDirectory, "package.json"),
  JSON.stringify(
    {
      name: "pi-web-e2e-extension",
      version: "1.0.0",
      type: "module",
      pi: { extensions: ["extension.mjs"] },
    },
    null,
    2,
  ),
)
await writeFile(
  join(fixtureExtensionDirectory, "extension.mjs"),
  `export default function e2eExtension(pi) {
  pi.registerCommand("interaction-test", {
    description: "Exercise session-scoped extension interaction",
    async handler(_args, context) {
      const value = await context.ui.input("E2E interaction", "pairing code")
      context.ui.setStatus("e2e-interaction", value === undefined ? undefined : "resolved:" + value)
    },
  })
}
`,
)
const agentDirectory = join(home, ".pi", "agent")
await mkdir(join(agentDirectory, "npm"), { recursive: true })
await writeFile(
  fixtureNpmCommand,
  `import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
const args = process.argv.slice(2)
if (args.includes("uninstall")) {
  await writeFile(${JSON.stringify(fixtureNpmCommandLog)}, args.join(" "))
  process.exit(1)
}
const child = spawn("npm", args, { stdio: "inherit" })
child.once("error", () => process.exit(1))
child.once("exit", (code) => process.exit(code ?? 1))
`,
)
await writeFile(
  join(agentDirectory, "settings.json"),
  JSON.stringify({
    packages: [fixtureExtensionDirectory, ...(extensionPath === undefined ? [] : [extensionPath])],
    npmCommand: [process.execPath, fixtureNpmCommand],
  }),
)
process.env.HOME = home
process.env.USERPROFILE = home
const { SessionManager } = await import("@earendil-works/pi-coding-agent")
const seededSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000001",
})
seededSession.appendMessage({ role: "user", content: "seed root", timestamp: 1_700_000_000_000 })
seededSession.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "seed reply" }],
  api: "anthropic-messages",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1_700_000_000_001,
})
await run("git", ["init", "--initial-branch=main"])
await run("git", ["add", "hello.txt"])
await run("git", [
  "-c",
  "user.name=pi-web-e2e",
  "-c",
  "user.email=pi-web-e2e@example.invalid",
  "commit",
  "-m",
  "test: initialize fixture",
])

const server = spawn(process.execPath, [viteCli, "dev", "--host", "127.0.0.1", "--port", String(requestedPort)], {
  cwd: root,
  env: {
    ...process.env,
    PI_WEB_OPEN_BROWSER: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
const baseURL = await waitForServerUrl(server).catch((error) => {
  if (server.exitCode === null) server.kill("SIGTERM")
  throw error
})
await waitForHealth(baseURL)
const playwrightEnv = {
  ...process.env,
  ...(operatorHome === undefined ? {} : { HOME: operatorHome }),
  ...(operatorUserProfile === undefined ? {} : { USERPROFILE: operatorUserProfile }),
  PI_WEB_E2E_BASE_URL: baseURL,
}
delete playwrightEnv.FORCE_COLOR
const playwright = spawn(process.execPath, [packageManagerEntry, "exec", "playwright", "test"], {
  cwd: root,
  env: playwrightEnv,
  stdio: "inherit",
})

const forward = (signal) => {
  if (playwright.exitCode === null) playwright.kill(signal)
}
let closePromise
const closeServer = () =>
  (closePromise ??= new Promise((resolve) => {
    if (server.exitCode !== null) {
      resolve()
      return
    }
    server.once("exit", () => resolve())
    server.kill("SIGTERM")
  }))
const stop = (signal) => {
  forward(signal)
  void closeServer()
}
process.once("SIGINT", () => stop("SIGINT"))
process.once("SIGTERM", () => stop("SIGTERM"))

const exitCode = await new Promise((resolve, reject) => {
  playwright.once("error", reject)
  playwright.once("exit", (code) => resolve(code ?? 1))
}).finally(closeServer)
process.exitCode = exitCode
