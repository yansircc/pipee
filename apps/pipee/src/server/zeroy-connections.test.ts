import { expect, it } from "vite-plus/test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { layer as nodeServices } from "@effect/platform-node/NodeServices"
import { ZeroYConnections, ZeroYConnectionsLive } from "./zeroy-connections"
import { ZeroYConnectionRegistryProviderLive } from "./zeroy-connection-registry-provider"

/**
 * Exercise the Pipee pairing orchestration against a stubbed WordPress REST
 * surface. A single managed runtime keeps one ZeroYConnections instance (and
 * its in-memory pending pairing state) across the tests in this file.
 */

// A sequence makes every exchange return a fresh grantId so re-pairing the
// same site can be observed superseding the previous grant.
let exchangeSequence = 0
const grantExchangeResponse = () => {
  exchangeSequence += 1
  return JSON.stringify({
    contract: "zeroy/connection-grant@1",
    grantId: `22222222-3333-4444-5555-${String(exchangeSequence).padStart(12, "0")}`,
    siteId: "0ba8bf56-1e2c-4e83-b629-0f9abd21cbac",
    clientId: "pipee-local",
    label: "Staging",
    createdAt: "2026-08-07T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  })
}

type StubCall = { url: string; body?: string }

const withStubFetch = (calls: Array<StubCall>) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined })
    if (url.endsWith("/connection/authorize")) {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
      const intentId = typeof body.intent_id === "string" ? body.intent_id : "intent-1"
      return new Response(JSON.stringify({ contract: "zeroy/connection-authorization-intent@1", intentId }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.endsWith("/connection/exchange")) {
      return new Response(grantExchangeResponse(), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("{}", { status: 404 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

const runtime = ManagedRuntime.make(
  ZeroYConnectionsLive.pipe(Layer.provide(ZeroYConnectionRegistryProviderLive), Layer.provide(nodeServices)),
)

const service = () => runtime.runPromise(ZeroYConnections.pipe(Effect.map((connections) => connections)))

let pairedIntentId: string | null = null
let pairedState: string | null = null

it("beginPairing creates a WordPress intent and returns a browser URL", async () => {
  const calls: Array<StubCall> = []
  const restore = withStubFetch(calls)
  try {
    const connections = await service()
    const intent = await runtime.runPromise(connections.beginPairing("https://example.test", "Staging"))
    pairedIntentId = intent.intentId
    pairedState = new URL(intent.authorizationUrl).searchParams.get("state")
    expect(intent.authorizationUrl).toContain("https://example.test/wp-admin/admin.php?page=zeroy-connections")
    expect(intent.authorizationUrl).toContain(`intent_id=${pairedIntentId}`)
    expect(calls).toHaveLength(1)
  } finally {
    restore()
  }
})

it("exchangeCode completes the pairing and persists the connection", async () => {
  const calls: Array<StubCall> = []
  const restore = withStubFetch(calls)
  try {
    const connections = await service()
    const list = await runtime.runPromise(connections.exchangeCode(pairedIntentId!, "grant-secret", pairedState!))
    expect(list.sites).toHaveLength(1)
    expect(list.sites[0]!.label).toBe("Staging")
    expect(list.sites[0]!.endpoint).toBe("https://example.test")
    expect(calls.some((call) => call.url.endsWith("/connection/exchange"))).toBe(true)
  } finally {
    restore()
  }
})

it("revoke marks the connection revoked", async () => {
  const calls: Array<StubCall> = []
  const restore = withStubFetch(calls)
  try {
    const connections = await service()
    await runtime.runPromise(connections.revoke("0ba8bf56-1e2c-4e83-b629-0f9abd21cbac"))
    const list = await runtime.runPromise(connections.list)
    expect(list.sites).toHaveLength(1)
    expect(list.sites[0]!.revoked).toBe(true)
  } finally {
    restore()
  }
})

it("pairWithCode pairs directly without a Pipee pending intent", async () => {
  const calls: Array<StubCall> = []
  const restore = withStubFetch(calls)
  try {
    const connections = await service()
    const list = await runtime.runPromise(
      connections.pairWithCode({
        endpoint: "https://example2.test",
        intentId: "wp-intent",
        code: "wp-pairing-code",
        state: "wp-state",
        redirectUri: "http://127.0.0.1:30141/zeroy/connect/callback",
        label: "WP-initiated",
      }),
    )
    expect(list.sites.some((site) => site.label === "WP-initiated")).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/connection/exchange"))).toBe(true)
  } finally {
    restore()
  }
})

it("re-pairing a site revokes the superseded WordPress grant", async () => {
  const calls: Array<StubCall> = []
  const restore = withStubFetch(calls)
  try {
    const connections = await service()
    const before = await runtime.runPromise(connections.list)
    const previous = before.sites.find(
      (site) => site.siteId === "0ba8bf56-1e2c-4e83-b629-0f9abd21cbac" && !site.revoked,
    )
    expect(previous).toBeDefined()
    const previousGrantId = previous!.grantId
    await runtime.runPromise(
      connections.pairWithCode({
        endpoint: "https://example2.test",
        intentId: "wp-intent-2",
        code: "wp-pairing-code-2",
        state: "wp-state-2",
        redirectUri: "http://127.0.0.1:30141/zeroy/connect/callback",
        label: "WP-initiated-2",
      }),
    )
    const revokeCall = calls.find((call) => call.url.includes(`/connection/grants/${previousGrantId}`))
    expect(revokeCall).toBeDefined()
    expect(revokeCall!.url).toContain("https://example2.test/wp-json/zeroy/v1/connection/grants/")
    const after = await runtime.runPromise(connections.list)
    expect(after.sites.filter((site) => site.siteId === "0ba8bf56-1e2c-4e83-b629-0f9abd21cbac")).toHaveLength(1)
  } finally {
    restore()
  }
})
