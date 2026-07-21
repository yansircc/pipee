import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import spawn from "cross-spawn"

const projectDirectory = fileURLToPath(new URL("..", import.meta.url))
const allowedConsumers = new Set(["npm", "pnpm"])
const allowedChecks = new Set([
  "structure",
  "install",
  "bin",
  "cli",
  "health",
  "page",
  "browser",
  "sse",
  "cleanup",
  "port-release",
])
const options = { consumer: undefined, checks: undefined, archive: undefined }
const argumentsList = process.argv.slice(2).filter((argument) => argument !== "--")
for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index]
  if (argument === "--consumer" || argument === "--checks") {
    const value = argumentsList[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`)
    if (argument === "--consumer") options.consumer = value
    else options.checks = value
    index += 1
    continue
  }
  if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`)
  if (options.archive !== undefined) throw new Error("exactly one archive path is required")
  options.archive = argument
}
if (!allowedConsumers.has(options.consumer)) throw new Error("--consumer must be npm or pnpm")
if (!options.checks) throw new Error("--checks requires a comma-separated check set")
if (!options.archive) throw new Error("an exact archive path is required")
const checkList = options.checks
const checks = new Set(checkList.split(","))
if (checks.size === 0 || [...checks].some((check) => !allowedChecks.has(check))) {
  throw new Error("unsupported check set")
}
const runtimeChecks = ["bin", "cli", "health", "page", "browser", "sse", "cleanup", "port-release"]
if (runtimeChecks.some((check) => checks.has(check)) && !checks.has("install")) {
  throw new Error("runtime checks require install")
}
if (["page", "browser", "sse", "cleanup", "port-release"].some((check) => checks.has(check)) && !checks.has("health")) {
  throw new Error("server behavior checks require health")
}

const archive = resolve(projectDirectory, options.archive)
if (!existsSync(archive)) throw new Error(`archive does not exist: ${archive}`)
const temporaryRoot = await mkdtemp(join(tmpdir(), "pipee-candidate-"))
const consumerDirectory = join(temporaryRoot, `${options.consumer}-consumer`)
const commandExecutable = (name) =>
  process.platform === "win32" && ["npm", "npx", "pnpm"].includes(name) ? `${name}.cmd` : name
const packageBin = (name) => (process.platform === "win32" ? `${name}.cmd` : name)
const installTimeoutMs = 10 * 60_000
const stopTimeoutMs = 10_000

const spawnCommand = (command, args, spawnOptions = {}) =>
  spawn(commandExecutable(command), args, {
    ...spawnOptions,
  })

const run = (command, args, runOptions = {}) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawnCommand(command, args, {
      cwd: runOptions.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...runOptions.env },
      stdio: runOptions.stdio ?? "pipe",
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer =
      runOptions.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            if (process.platform === "win32") {
              spawnCommand("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).unref()
            } else if (child.pid !== undefined) {
              process.kill(-child.pid, "SIGKILL")
            }
          }, runOptions.timeoutMs)
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", rejectPromise)
    child.once("exit", (code) => {
      if (timer !== undefined) clearTimeout(timer)
      if (timedOut) return rejectPromise(new Error(`${command} exceeded ${runOptions.timeoutMs}ms`))
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`))
    })
  })

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null
const waitForExit = (child, timeoutMs) => {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    child.once("exit", onExit)
  })
}

const terminate = async (child) => {
  if (hasExited(child)) return
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(child.pid), "/t"]).catch(() => undefined)
  } else {
    child.kill("SIGTERM")
  }
  if (await waitForExit(child, stopTimeoutMs)) return
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(() => undefined)
  } else {
    child.kill("SIGKILL")
  }
  if (!(await waitForExit(child, stopTimeoutMs))) {
    throw new Error(`pipee process ${child.pid} did not exit`)
  }
}

const allocatePort = () =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once("error", rejectPromise)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        rejectPromise(new Error("could not allocate a loopback port"))
        return
      }
      server.close((error) => (error ? rejectPromise(error) : resolvePromise(address.port)))
    })
  })

const assertPortReleased = (port) =>
  new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once("error", rejectPromise)
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? rejectPromise(error) : resolvePromise()))
    })
  })

const waitForHealth = async (url, child) => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (hasExited(child)) throw new Error(`pipee exited before readiness: ${child.exitCode}`)
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {
      // Candidate server has not completed startup.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error(`pipee did not become ready at ${url}`)
}

const expectCliFailure = async (bin, args) => {
  const result = await run(bin, args, {
    cwd: consumerDirectory,
    env: { PIPEE_OPEN_BROWSER: "0" },
    timeoutMs: 5_000,
  }).then(
    () => ({ accepted: true, output: "" }),
    (error) => ({ accepted: false, output: String(error) }),
  )
  if (result.accepted || !result.output.includes("Usage: pipee")) {
    throw new Error(`invalid CLI invocation was not rejected: ${args.join(" ")}\n${result.output}`)
  }
}

const expectCliOutput = async (bin, args, expected) => {
  const result = await run(bin, args, {
    cwd: consumerDirectory,
    env: { PORT: "must-not-be-read", PIPEE_OPEN_BROWSER: "0" },
    timeoutMs: 5_000,
  })
  if (result.stdout !== expected || result.stderr !== "") {
    throw new Error(`unexpected CLI output: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
}

const inspectStructure = async () => {
  const { t: listArchive } = await import("tar")
  const listing = []
  await listArchive({ file: archive, onReadEntry: (entry) => listing.push(entry.path) })
  const forbidden = listing.filter(
    (entry) =>
      entry.includes(".output/server/node_modules/") ||
      entry.includes("/.next/") ||
      entry.includes("/src/") ||
      entry.includes(".cache"),
  )
  if (forbidden.length > 0) throw new Error(`tarball contains forbidden files:\n${forbidden.join("\n")}`)
  if (!listing.some((entry) => entry.endsWith("/.output/server/index.mjs"))) {
    throw new Error("tarball is missing the Nitro server entry")
  }
}

try {
  if (checks.has("structure")) await inspectStructure()
  await mkdir(consumerDirectory)
  if (checks.has("install")) {
    if (options.consumer === "npm") {
      await run("npm", ["init", "-y"], { cwd: consumerDirectory })
      await run(
        "npm",
        [
          "install",
          "--prefer-online",
          "--fetch-retries=2",
          "--fetch-retry-mintimeout=1000",
          "--fetch-retry-maxtimeout=5000",
          "--fetch-timeout=30000",
          archive,
        ],
        { cwd: consumerDirectory, timeoutMs: installTimeoutMs },
      )
    } else {
      await writeFile(
        join(consumerDirectory, "pnpm-workspace.yaml"),
        'allowBuilds:\n  "@google/genai": false\n  msgpackr-extract: false\n  protobufjs: false\n',
      )
      await writeFile(join(consumerDirectory, "package.json"), '{"private":true}\n')
      await run("pnpm", ["add", archive], { cwd: consumerDirectory, timeoutMs: installTimeoutMs })
    }
  }

  const bin = join(consumerDirectory, "node_modules", ".bin", packageBin("pipee"))
  if (checks.has("bin") && !existsSync(bin)) throw new Error(`candidate bin is missing: ${bin}`)
  if (checks.has("cli")) {
    const manifest = JSON.parse(
      await readFile(join(consumerDirectory, "node_modules", "@yansircc", "pipee", "package.json"), "utf8"),
    )
    await expectCliOutput(bin, ["-v"], `${manifest.version}\n`)
    await expectCliOutput(bin, ["--version"], `${manifest.version}\n`)
    for (const helpArgument of ["-h", "--help"]) {
      const result = await run(bin, [helpArgument], {
        cwd: consumerDirectory,
        env: { PORT: "must-not-be-read", PIPEE_OPEN_BROWSER: "0" },
        timeoutMs: 5_000,
      })
      if (!result.stdout.startsWith("Usage: pipee [options]\n") || !result.stdout.includes("-v, --version")) {
        throw new Error(`incomplete CLI help: ${helpArgument}\n${result.stdout}`)
      }
    }
    await expectCliFailure(bin, ["--port"])
    await expectCliFailure(bin, ["--port", "0"])
    await expectCliFailure(bin, ["--unknown"])
  }
  if (checks.has("health")) {
    const port = await allocatePort()
    const child = spawnCommand(bin, ["-p", String(port), "-H", "127.0.0.1"], {
      cwd: consumerDirectory,
      env: { ...process.env, PIPEE_OPEN_BROWSER: "0" },
      stdio: "pipe",
    })
    let stderr = ""
    let stream
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const url = `http://127.0.0.1:${port}`
    try {
      await waitForHealth(url, child)
      if (checks.has("page")) {
        const response = await fetch(url)
        if (!response.ok || !(await response.text()).includes("Pipee")) {
          throw new Error("candidate page smoke failed")
        }
      }
      if (checks.has("browser")) {
        const { chromium } = await import("@playwright/test")
        const browser = await chromium.launch({ headless: true })
        const page = await browser.newPage()
        const pageErrors = []
        page.on("pageerror", (error) => pageErrors.push(error.message))
        try {
          await page.goto(url, { waitUntil: "load" })
          await page.waitForTimeout(1_000)
        } finally {
          await browser.close()
        }
        if (pageErrors.length > 0) throw new Error(`candidate browser errors:\n${pageErrors.join("\n")}`)
      }
      if (checks.has("sse")) {
        stream = await fetch(`${url}/api/sessions/running/events`)
        if (!stream.ok || !stream.headers.get("content-type")?.includes("text/event-stream")) {
          throw new Error("candidate SSE smoke failed")
        }
      }
    } finally {
      await terminate(child)
      await stream?.body?.cancel().catch(() => undefined)
    }
    if (checks.has("cleanup") && !hasExited(child)) throw new Error("candidate process remained live")
    if (checks.has("port-release")) await assertPortReleased(port)
    if (stderr.includes("Build artifacts not found")) throw new Error(stderr)
    if (process.platform !== "win32" && /Graceful shutdown timed out|Forcibly closing connections/.test(stderr)) {
      throw new Error(`candidate server forced shutdown with an active connection\n${stderr}`)
    }
  }
  process.stdout.write(
    `${JSON.stringify({ candidate: true, platform: process.platform, consumer: options.consumer, checks: [...checks] })}\n`,
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
