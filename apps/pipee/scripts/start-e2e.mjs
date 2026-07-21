import { spawn } from "node:child_process"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import process from "node:process"
import { stripVTControlCharacters } from "node:util"
import { x as extractArchive } from "tar"

const root = fileURLToPath(new URL("..", import.meta.url))
const fixtureRoot = join(root, "test-results", "e2e-fixture")
const home = join(fixtureRoot, "home")
const workspace = join(fixtureRoot, "workspace")
const operatorHome = process.env.HOME
const operatorUserProfile = process.env.USERPROFILE
const packageManagerEntry = process.env.npm_execpath
if (!packageManagerEntry) throw new Error("start-e2e must run through the repository package manager")
const requestedPort = Number(process.env.PIPEE_E2E_PORT ?? "30141")
if (!Number.isSafeInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("PIPEE_E2E_PORT must be an integer between 1 and 65535")
}
const extensionPath = process.env.PIPEE_E2E_EXTENSION_PATH
const vitePackageDirectory = dirname(fileURLToPath(import.meta.resolve("vite/package.json")))
const viteCli = join(vitePackageDirectory, "dist", "vite", "node", "cli.js")

const run = (command, args, cwd = workspace) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" })
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
await writeFile(join(workspace, "long.txt"), Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join("\n"))
await mkdir(join(workspace, "nested"), { recursive: true })
await writeFile(join(workspace, "nested", "deep-result.ts"), "export const deepResult = 42\n")
const fixtureSkillDirectory = join(workspace, ".agents", "skills", "e2e-skill")
await mkdir(fixtureSkillDirectory, { recursive: true })
await writeFile(
  join(fixtureSkillDirectory, "SKILL.md"),
  "---\nname: e2e-skill\ndescription: isolated fixture\n---\n\n# E2E skill\n",
)
await mkdir(join(fixtureSkillDirectory, "references"), { recursive: true })
await writeFile(join(fixtureSkillDirectory, "references", "guide.md"), "# Guide\n\nSkill-owned reference.\n")
const fixturePluginDirectory = join(fixtureRoot, "e2e-plugin")
const fixtureExtensionSource = join(fixtureRoot, "e2e-extension-source")
const fixtureExtensionArchiveDirectory = join(fixtureRoot, "e2e-extension-archive")
const fixtureExtensionDirectory = join(fixtureRoot, "e2e-extension-raw", "package")
const fixtureNpmCommandLog = join(fixtureRoot, "npm-command.log")
const fixtureNpmCommand = join(fixtureRoot, "npm-command.mjs")
const fixturePluginSkillDirectory = join(fixturePluginDirectory, "skills", "plugin-skill")
await mkdir(fixturePluginSkillDirectory, { recursive: true })
await writeFile(
  join(fixturePluginDirectory, "package.json"),
  JSON.stringify(
    {
      name: "pipee-e2e-plugin",
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
await mkdir(join(fixtureExtensionSource, "dist", "pi"), { recursive: true })
await mkdir(join(fixtureExtensionSource, "dist", "web"), { recursive: true })
await writeFile(
  join(fixtureExtensionSource, "package.json"),
  JSON.stringify(
    {
      name: "pipee-e2e-extension",
      version: "1.0.0",
      description: "Synthetic raw-archive Web Surface",
      type: "module",
      files: ["dist"],
      pi: { extensions: ["./dist/pi/extension.js"] },
      pipee: { web: { contract: "pipee/web-surface@2", document: "./dist/web/index.html", title: "E2E Surface" } },
    },
    null,
    2,
  ),
)
await writeFile(
  join(fixtureExtensionSource, "dist", "pi", "extension.js"),
  `export default function e2eExtension(pi) {
  let surface
  pi.on("session_start", (_event, context) => {
    surface = context.ui.getPipeeCapability("pipee-e2e-extension", "pipee/web-surface-runtime@2").register({
      dispatch: async (request) => ({ _tag: "Accepted", payload: Number(request.payload) + 1 }),
    })
    surface.replace({ answer: 41 })
  })
  pi.on("session_shutdown", () => { surface?.release(); surface = undefined })
  pi.registerCommand("interaction-test", {
    description: "Exercise session-scoped extension interaction",
    async handler(_args, context) {
      const value = await context.ui.input("E2E interaction", "pairing code")
      context.ui.setStatus("e2e-interaction", value === undefined ? undefined : "resolved:" + value)
    },
  })
  pi.registerCommand("interaction-queue-test", {
    description: "Exercise FIFO extension interactions",
    async handler(_args, context) {
      const [first, second] = await Promise.all([
        context.ui.input("First interaction", "first value"),
        context.ui.input("Second interaction", "second value"),
      ])
      context.ui.setStatus("e2e-interaction-queue", String(first) + ":" + String(second))
    },
  })
  pi.registerCommand("interaction-timeout-test", {
    description: "Exercise active interaction timeout",
    async handler(_args, context) {
      const value = await context.ui.input("Timed interaction", "wait for timeout", { timeout: 50 })
      context.ui.setStatus("e2e-interaction-timeout", value === undefined ? "cancelled" : "resolved:" + value)
    },
  })
  pi.registerCommand("interaction-abort-test", {
    description: "Exercise queued interaction AbortSignal",
    async handler(_args, context) {
      const controller = new AbortController()
      const blocker = context.ui.input("Abort blocker", "resolve blocker")
      const queued = context.ui.input("Aborted interaction", "must not activate", { signal: controller.signal })
      controller.abort()
      const queuedValue = await queued
      const blockerValue = await blocker
      context.ui.setStatus(
        "e2e-interaction-abort",
        String(queuedValue) + ":" + String(blockerValue),
      )
    },
  })
  pi.registerCommand("interaction-close-test", {
    description: "Exercise runtime close cancellation",
    async handler(_args, context) {
      const [active, queued] = await Promise.all([
        context.ui.input("Close active interaction", "active close"),
        context.ui.input("Close queued interaction", "queued close"),
      ])
      context.ui.setStatus("e2e-interaction-close", String(active) + ":" + String(queued))
    },
  })
}
`,
)
await writeFile(
  join(fixtureExtensionSource, "dist", "web", "index.html"),
  `<!doctype html><html><head><link rel="stylesheet" href="./style.css" crossorigin="anonymous"></head><body><main><h1>E2E Surface</h1><output id="result">waiting</output><div id="isolation"></div></main><script type="module" src="./app.js" crossorigin="anonymous"></script></body></html>`,
)
await writeFile(
  join(fixtureExtensionSource, "dist", "web", "style.css"),
  `body{font:16px system-ui;background:#f8fafc;color:#0f172a}main{padding:24px}output{font-weight:700}`,
)
await writeFile(
  join(fixtureExtensionSource, "dist", "web", "app.js"),
  `
const result = document.querySelector("#result")
const isolation = document.querySelector("#isolation")
try { void parent.document.body; isolation.textContent = "parent access failed" } catch { isolation.textContent = "parent access blocked" }
addEventListener("message", (event) => {
  if (event.data?.type !== "pipee-web-surface-port") return
  const port = event.ports[0]
  port.onmessage = ({ data }) => {
    if (data?._tag === "init") {
      result.textContent = String(data.surface.view?.answer ?? "missing")
      port.postMessage({ _tag: "dispatch", requestId: "e2e-action", sessionId: data.session.sessionId, payload: 41 })
    }
    if (data?._tag === "action-result") result.textContent = String(data.outcome?.payload ?? data.outcome?.reason ?? "failed")
  }
  port.start()
  port.postMessage({ _tag: "ready", contract: "pipee/web-surface-channel@2" })
  setTimeout(() => { throw new Error("intentional e2e surface failure") }, 250)
})
`,
)
await mkdir(fixtureExtensionArchiveDirectory, { recursive: true })
await run(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", fixtureExtensionArchiveDirectory],
  fixtureExtensionSource,
)
const extensionArchives = (await readdir(fixtureExtensionArchiveDirectory)).filter((file) => file.endsWith(".tgz"))
if (extensionArchives.length !== 1)
  throw new Error(`expected one synthetic extension archive, found ${extensionArchives.length}`)
await mkdir(join(fixtureRoot, "e2e-extension-raw"), { recursive: true })
await extractArchive({
  file: join(fixtureExtensionArchiveDirectory, extensionArchives[0]),
  cwd: join(fixtureRoot, "e2e-extension-raw"),
})
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
const deepSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000004",
})
for (let index = 0; index < 5_000; index += 1) {
  deepSession.appendMessage({ role: "user", content: `deep fixture ${index}`, timestamp: 1_600_000_000_000 + index })
}
deepSession.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "deep fixture tail" }],
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
  timestamp: 1_600_000_005_000,
})
const seededSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000001",
})
const seededRootId = seededSession.appendMessage({
  role: "user",
  content: "seed root",
  timestamp: 1_700_000_000_000,
})
seededSession.appendMessage({
  role: "user",
  content: "alternate fixture branch",
  timestamp: 1_700_000_000_002,
})
seededSession.branch(seededRootId)
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
const processSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000005",
})
processSession.appendMessage({ role: "user", content: "exercise the process projection", timestamp: 1_700_000_010_000 })
processSession.appendMessage({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "inspect the request" },
    { type: "text", text: "I will inspect the workspace first." },
    { type: "toolCall", toolCallId: "fixture-call-1", toolName: "read", input: { path: "hello.txt" } },
  ],
  api: "anthropic-messages",
  provider: "fixture-provider",
  model: "fixture-model",
  usage: {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 16,
    cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
  },
  stopReason: "toolUse",
  timestamp: 1_700_000_010_100,
  generationDurationMs: 1_000,
})
processSession.appendMessage({
  role: "toolResult",
  toolCallId: "fixture-call-1",
  toolName: "read",
  content: [{ type: "text", text: "hello from the isolated e2e workspace" }],
  isError: false,
  timestamp: 1_700_000_010_200,
})
processSession.appendMessage({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "summarize the result" },
    { type: "text", text: "The workspace read succeeded; I am preparing the result." },
  ],
  api: "anthropic-messages",
  provider: "fixture-provider",
  model: "fixture-model",
  usage: {
    input: 12,
    output: 6,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
  },
  stopReason: "stop",
  timestamp: 1_700_000_010_300,
  generationDurationMs: 500,
})
const failedSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000002",
})
failedSession.appendMessage({ role: "user", content: "trigger provider failure", timestamp: 1_700_000_000_002 })
failedSession.appendMessage({
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  errorMessage: "Fixture provider timed out.",
  timestamp: 1_700_000_000_003,
})
const longSession = SessionManager.create(workspace, undefined, {
  id: "00000000-0000-4000-8000-000000000003",
})
for (let index = 0; index < 30; index += 1) {
  longSession.appendMessage({
    role: "user",
    content: `scroll fixture message ${index + 1}: ${"content ".repeat(18)}`,
    timestamp: 1_700_000_001_000 + index,
  })
}
longSession.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "scroll fixture tail" }],
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
  timestamp: 1_700_000_001_030,
})
await run("git", ["init", "--initial-branch=main"])
await run("git", ["add", "hello.txt"])
await run("git", [
  "-c",
  "user.name=pipee-e2e",
  "-c",
  "user.email=pipee-e2e@example.invalid",
  "commit",
  "-m",
  "test: initialize fixture",
])

const server = spawn(process.execPath, [viteCli, "dev", "--host", "127.0.0.1", "--port", String(requestedPort)], {
  cwd: root,
  env: {
    ...process.env,
    PIPEE_OPEN_BROWSER: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
const baseURL = await waitForServerUrl(server).catch((error) => {
  if (server.exitCode === null) server.kill("SIGTERM")
  throw error
})
await waitForHealth(baseURL)
const deepSessionResponse = await fetch(
  `${baseURL}/api/sessions/00000000-0000-4000-8000-000000000004?deferThinking=1&deferMedia=1`,
)
if (!deepSessionResponse.ok) {
  throw new Error(`Deep session projection returned HTTP ${deepSessionResponse.status}`)
}
const deepSessionSnapshot = await deepSessionResponse.json()
if (
  deepSessionSnapshot.branchNodes?.length !== 2 ||
  JSON.stringify(deepSessionSnapshot.branchNodes).length > 1_000 ||
  deepSessionSnapshot.context?.messages?.length !== 200 ||
  deepSessionSnapshot.info?.messageCount !== 5_001 ||
  deepSessionSnapshot.info?.firstMessage !== "deep fixture 0" ||
  deepSessionSnapshot.contextPage?.hasMoreBefore !== true
) {
  throw new Error("Deep session projection was not flat and bounded")
}
const playwrightEnv = {
  ...process.env,
  ...(operatorHome === undefined ? {} : { HOME: operatorHome }),
  ...(operatorUserProfile === undefined ? {} : { USERPROFILE: operatorUserProfile }),
  PIPEE_E2E_BASE_URL: baseURL,
}
delete playwrightEnv.FORCE_COLOR
const requestedPlaywrightArgs = process.argv.slice(2)
const playwrightArgs = requestedPlaywrightArgs[0] === "--" ? requestedPlaywrightArgs.slice(1) : requestedPlaywrightArgs
const playwright = spawn(process.execPath, [packageManagerEntry, "exec", "playwright", "test", ...playwrightArgs], {
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
