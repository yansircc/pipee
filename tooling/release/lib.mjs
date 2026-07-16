import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))

export const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"))

export const suiteConfig = () => readJson("release/suite.config.json")

export const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "")
      process.stderr.write(result.stderr ?? "")
    }
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`)
  }
  return result.stdout ?? ""
}

export const sha512Integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`
