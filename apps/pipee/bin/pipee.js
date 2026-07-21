#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const serverEntry = join(packageDir, ".output", "server", "index.mjs")
const usage = `Usage: pipee [options]

Options:
  -p, --port <port>      Port to listen on (default: 30141)
  -H, --hostname <host>  Hostname to bind (default: 127.0.0.1)
  -h, --help             Show this help
  -v, --version          Show the installed version

Environment:
  PIPEE_OPEN_BROWSER=0  Do not open a browser automatically`
const failUsage = (message) => {
  console.error(`pipee: ${message}`)
  console.error(usage)
  process.exit(64)
}

let values
try {
  ;({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      port: { type: "string", short: "p" },
      hostname: { type: "string", short: "H" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
    strict: true,
  }))
} catch (error) {
  failUsage(error instanceof Error ? error.message : "invalid arguments")
}

if (values.help) {
  console.log(usage)
  process.exit(0)
}
if (values.version) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"))
  console.log(manifest.version)
  process.exit(0)
}

if (!existsSync(serverEntry)) {
  console.error("Build artifacts not found. Please reinstall @yansircc/pipee.")
  process.exit(1)
}

const portInput = values.port ?? process.env.PORT ?? "30141"
if (!/^\d+$/.test(portInput)) failUsage(`invalid port: ${portInput}`)
const portNumber = Number(portInput)
if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  failUsage(`port must be between 1 and 65535: ${portInput}`)
}
const port = String(portNumber)
const hostname = (values.hostname ?? process.env.PIPEE_HOST ?? process.env.HOST ?? "127.0.0.1").trim()
if (!hostname || /[\s/?#]/.test(hostname)) failUsage(`invalid hostname: ${hostname || "(empty)"}`)
process.env.PORT = port
process.env.HOST = hostname
process.env.NITRO_PORT = port
process.env.NITRO_HOST = hostname
process.env.PIPEE_PLATFORM ??= process.platform

await import(pathToFileURL(serverEntry).href)

const browserHost = hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname
const url = `http://${browserHost.includes(":") ? `[${browserHost}]` : browserHost}:${port}`
const healthUrl = `${url}/api/health`

let ready = false
for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
  try {
    const response = await fetch(healthUrl)
    ready = response.ok
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

if (!ready) {
  console.error(`pipee did not become ready at ${healthUrl}`)
  process.exit(1)
} else if (process.env.PIPEE_OPEN_BROWSER !== "0") {
  const command = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open"
  const opener = spawn(command, [url], {
    shell: process.platform === "win32",
    detached: true,
    stdio: "ignore",
  })
  opener.on("error", (error) => console.warn(`Could not open browser automatically: ${error.message}`))
  opener.unref()
}
