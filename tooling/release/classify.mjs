import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"))
const suiteConfig = () => readJson("release/suite.config.json")

const commit = process.argv[2]
if (!commit) throw new Error("usage: classify.mjs <commit>")
const git = (args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
const record = parseReleaseRecord(git(["show", "-s", "--format=%B", commit]))

if (record !== undefined) {
  const parents = git(["show", "-s", "--format=%P", commit]).split(/\s+/).filter(Boolean)
  const manifestPaths = ["package.json", ...suiteConfig().packages.map(({ path }) => `${path}/package.json`)]
  const manifestVersions = manifestPaths.map((path) => readJson(path).version)
  assertReleaseRecordCommit({ record, parents, manifestVersions })
}

const result = record === undefined ? "false" : "true"
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release_commit=${result}\n`)
process.stdout.write(`${result}\n`)
