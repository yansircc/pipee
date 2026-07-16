import { appendFileSync } from "node:fs"
import { assertReleaseRecordCommit, parseReleaseRecord } from "./release-record.mjs"
import { readJson, run, suiteConfig } from "./lib.mjs"

const commit = process.argv[2]
if (!commit) throw new Error("usage: classify.mjs <commit>")
const git = (args) => run("git", args, { capture: true }).trim()
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
