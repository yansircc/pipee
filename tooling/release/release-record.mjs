const strictVersion = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)"
const subjectPattern = new RegExp(`^chore\\(release\\): suite-v(${strictVersion})$`)

const uniqueTrailer = (lines, name, pattern) => {
  const values = lines.flatMap((line) => {
    const match = line.match(pattern)
    return match?.[1] === undefined ? [] : [match[1]]
  })
  if (values.length !== 1) throw new Error(`release record requires exactly one ${name} trailer`)
  return values[0]
}

export const parseReleaseRecord = (message) => {
  const lines = String(message).split(/\r?\n/)
  const subject = lines[0] ?? ""
  const hasReleaseMarker =
    subject.startsWith("chore(release):") || lines.some((line) => /^Release-Source:/.test(line))
  if (!hasReleaseMarker) return undefined

  const subjectMatch = subject.match(subjectPattern)
  if (subjectMatch?.[1] === undefined) throw new Error("release record has a non-canonical subject")
  return {
    version: subjectMatch[1],
    source: uniqueTrailer(lines, "Release-Source", /^Release-Source:\s*([0-9a-f]{40})\s*$/),
    bump: uniqueTrailer(lines, "Release-Bump", /^Release-Bump:\s*(major|minor|patch)\s*$/),
  }
}

export const assertReleaseRecordCommit = ({ record, parents, manifestVersions }) => {
  if (parents.length !== 1 || parents[0] !== record.source) {
    throw new Error("release commit must have its source commit as the only parent")
  }
  if (manifestVersions.length === 0 || !manifestVersions.every((version) => version === record.version)) {
    throw new Error("release record version does not match every Suite manifest")
  }
  return record
}
