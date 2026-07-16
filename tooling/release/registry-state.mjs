export const classifyRegistryLookup = ({ status, stdout = "", stderr = "" }) => {
  if (status === 0) {
    const integrity = JSON.parse(stdout)
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error("registry returned an invalid integrity projection")
    }
    return { _tag: "Present", integrity }
  }
  if (/E404|404 Not Found|is not in this registry/i.test(stderr)) return { _tag: "Missing" }
  throw new Error(`registry lookup failed: ${stderr.trim() || `exit ${status}`}`)
}

export const publicationDecision = (lookup, expectedIntegrity) => {
  if (lookup._tag === "Missing") return { _tag: "Publish" }
  if (lookup.integrity !== expectedIntegrity) {
    throw new Error("registry version exists with different bytes")
  }
  return { _tag: "Reuse" }
}

export const requireRegistryIntegrity = (lookup, expectedIntegrity) => {
  if (lookup._tag === "Missing") throw new Error("registry version is not publicly visible")
  if (lookup.integrity !== expectedIntegrity) throw new Error("registry integrity mismatch")
}
