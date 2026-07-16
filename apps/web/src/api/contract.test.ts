import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { expect, test } from "@effect/vitest"
import { Conflict, OperationFailed, PiWebApi, PromptProgressEvent, RuntimeEnvelope } from "./contract"
import { toPublicError } from "./server"
import { PiAdapterError, PiPromptIdempotencyError } from "@/server/pi-adapter-errors"

interface EndpointFact {
  readonly group: string
  readonly identifier: string
  readonly method: string
  readonly path: string
  readonly errorStatuses: ReadonlyArray<number>
  readonly hasSameOrigin: boolean
}

const endpointFacts = (): ReadonlyArray<EndpointFact> => {
  const facts: Array<EndpointFact> = []
  HttpApi.reflect(PiWebApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint, errors, middleware }) => {
      facts.push({
        group: group.identifier,
        identifier: endpoint.identifier,
        method: endpoint.method,
        path: endpoint.path,
        errorStatuses: [...errors.keys()],
        hasSameOrigin: middleware.size > 0,
      })
    },
  })
  return facts
}

test("owns every API route in one unique HttpApi inventory", () => {
  const facts = endpointFacts()
  const routeKeys = facts.map((fact) => `${fact.method} ${fact.path}`)
  expect(facts.length).toBeGreaterThan(50)
  expect(new Set(routeKeys).size).toBe(routeKeys.length)
  expect(facts.every((fact) => fact.path.startsWith("/api/"))).toBe(true)
  expect(facts.some((fact) => fact.path.startsWith("/api/agent"))).toBe(false)
})

test("models every session mutation as a dedicated action endpoint", () => {
  const actions = endpointFacts().filter((fact) => fact.group === "sessionActions")
  expect(
    actions
      .filter((fact) => fact.method === "POST")
      .every(
        (fact) =>
          fact.path.includes("/api/sessions/:id/actions/") ||
          fact.path.includes("/api/sessions/:id/companions/") ||
          fact.path.includes("/api/sessions/:id/runtimes/") ||
          fact.identifier === "tools" ||
          fact.identifier === "commands" ||
          fact.identifier === "stats" ||
          fact.identifier === "lastAssistant",
      ),
  ).toBe(true)
  expect(actions.map((fact) => fact.identifier)).toEqual(
    expect.arrayContaining([
      "prompt",
      "steer",
      "followUp",
      "abort",
      "fork",
      "navigate",
      "compact",
      "bash",
      "slashCommand",
      "loopControl",
      "weixinControl",
      "chromeControl",
      "resolveInteraction",
    ]),
  )
  expect(actions.map((fact) => fact.identifier)).not.toEqual(
    expect.arrayContaining(["extensionCommand", "extensionUiResponse", "extensionUiInput"]),
  )
})

test("attaches same-origin middleware and the complete tagged error algebra", () => {
  const protectedEndpoints = endpointFacts().filter((fact) => fact.group !== "meta")
  expect(protectedEndpoints.every((fact) => fact.hasSameOrigin)).toBe(true)
  expect(
    protectedEndpoints.every((fact) =>
      [400, 403, 404, 409, 413, 500, 501].every((status) => fact.errorStatuses.includes(status)),
    ),
  ).toBe(true)
})

test("decodes structured conflict detail and rejects untagged failures", () => {
  const conflict = Schema.decodeUnknownOption(Conflict)({
    _tag: "Conflict",
    message: "dirty",
    detail: { _tag: "DirtyWorktree", path: "/repo/.worktrees/topic" },
  })
  expect(conflict._tag).toBe("Some")
  expect(
    Schema.decodeUnknownOption(Conflict)({
      _tag: "Conflict",
      message: "unsafe replay",
      detail: {
        _tag: "IdempotencyConflict",
        requestId: "message-42",
        reason: "InDoubt",
      },
    })._tag,
  ).toBe("Some")
  expect(Schema.decodeUnknownOption(OperationFailed)({ message: "missing tag" })._tag).toBe("None")
})

test("requires runtime identity around every run event", () => {
  expect(
    Schema.decodeUnknownOption(RuntimeEnvelope)({
      identity: { registryId: "registry-1", runtimeEpoch: 1, runtimeId: "runtime-1" },
      event: { _tag: "RunFinished", runId: "run-1" },
    })._tag,
  ).toBe("Some")
  expect(
    Schema.decodeUnknownOption(RuntimeEnvelope)({
      event: { _tag: "RunFinished", runId: "run-1" },
    })._tag,
  ).toBe("None")
})

test("decodes only run-correlated prompt progress events", () => {
  expect(
    Schema.decodeUnknownOption(PromptProgressEvent)({
      _tag: "ToolStarted",
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "browser",
    })._tag,
  ).toBe("Some")
  expect(
    Schema.decodeUnknownOption(PromptProgressEvent)({
      _tag: "ToolStarted",
      toolCallId: "tool-1",
      toolName: "browser",
    })._tag,
  ).toBe("None")
})

test("never exposes API keys, OAuth codes, or message bodies in public errors", () => {
  const secrets = ["sk-live-secret", "oauth-manual-code", "private prompt body"]
  const failures = [
    new PiAdapterError({ operation: "auth.setApiKey", message: `rejected ${secrets[0]}` }),
    new PiAdapterError({ operation: "auth.oauth.input", message: `rejected ${secrets[1]}` }),
    new PiAdapterError({ operation: "runtime.prompt", message: `rejected ${secrets[2]}` }),
    new PiPromptIdempotencyError({
      requestId: "message-42",
      reason: "InDoubt",
      message: `unsafe ${secrets[2]}`,
    }),
  ]
  const encoded = JSON.stringify(failures.map(toPublicError))
  expect(secrets.every((secret) => !encoded.includes(secret))).toBe(true)
  expect(encoded).toContain("Authentication operation failed")
  expect(encoded).toContain("Pi operation failed")
  expect(encoded).toContain("Prior request may have executed")
})
