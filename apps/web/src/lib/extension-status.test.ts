import { Option } from "effect"
import { expect, test } from "@effect/vitest"
import { ChromeStatusProjection, ExtensionStatusContribution, type JsonValue } from "@/api/contract"
import {
  decodeChromeStatusProjection,
  extensionStructuredStatusOrUndefined,
  getLoopStatusProjection,
  getWeixinStatusProjection,
  isChromeAuthorized,
  sameWeixinStatusProjection,
} from "./extension-status"

const structured = (key: string, kind: string, version: number, value: JsonValue) =>
  ExtensionStatusContribution.make({ _tag: "Structured", key, kind, version, value })

test("decodes the pi-chrome readiness projection without interpreting display text", () => {
  const status = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 2,
    readiness: "ready",
    authorization: { expiresAt: 123_000 },
    connection: "connected",
    bridge: "running",
    requirements: [],
    connectorLabel: "Personal",
  })
  expect(Option.getOrNull(decodeChromeStatusProjection(status))).toEqual(status)
})

test("rejects incomplete or unknown status projections", () => {
  expect(Option.isNone(decodeChromeStatusProjection({ kind: "pi-chrome/status", version: 2 }))).toBe(true)
  expect(
    Option.isNone(
      decodeChromeStatusProjection({
        kind: "pi-chrome/status",
        version: 2,
        readiness: "ready",
        authorization: "indefinite",
        connection: "connected",
        bridge: "mystery",
        requirements: [],
      }),
    ),
  ).toBe(true)
})

test("preserves extension-owned JSON status projections without treating them as Chrome", () => {
  const weixin = {
    kind: "pi-weixin/status",
    version: 2,
    bindings: [
      { sessionId: "session-a", accountId: "wx-a", connected: true, phase: "Connected" as const },
      { sessionId: "session-b", accountId: "wx-b", connected: false, phase: "Stopped" as const },
    ],
  }
  expect(extensionStructuredStatusOrUndefined(weixin)).toEqual({
    kind: "pi-weixin/status",
    version: 2,
    value: weixin,
  })
  expect(isChromeAuthorized([structured("weixin", weixin.kind, weixin.version, weixin)])).toBe(false)
  expect(getWeixinStatusProjection([structured("weixin", weixin.kind, weixin.version, weixin)])).toEqual(weixin)
  expect(getWeixinStatusProjection([])).toBeUndefined()
})

test("decodes the session automation projection from structured extension status", () => {
  const projection = {
    kind: "pi-loop/status" as const,
    version: 1 as const,
    sessionId: "session-a",
    observedAt: 1_000,
    loops: [
      {
        id: "loop-a",
        prompt: "inspect the project",
        createdAt: 500,
        enabled: true,
        retention: "session" as const,
        schedule: { _tag: "Interval" as const, periodMs: 60_000 },
        phase: { _tag: "Scheduled" as const, dueAt: 61_000 },
      },
    ],
  }
  expect(getLoopStatusProjection([structured("pi-loop", projection.kind, projection.version, projection)])).toEqual(
    projection,
  )
  expect(
    getLoopStatusProjection([
      structured("pi-loop", projection.kind, projection.version, {
        ...projection,
        loops: [{ ...projection.loops[0], phase: { _tag: "unknown" } }],
      }),
    ]),
  ).toBeUndefined()
})

test("rejects ambiguous Weixin binding cardinality", () => {
  const status = (bindings: ReadonlyArray<{ sessionId: string; accountId: string; connected: boolean }>) => ({
    kind: "pi-weixin/status",
    version: 2,
    bindings,
  })
  expect(
    getWeixinStatusProjection([
      structured(
        "weixin",
        "pi-weixin/status",
        2,
        status([
          { sessionId: "session-a", accountId: "wx-a", connected: true },
          { sessionId: "session-a", accountId: "wx-b", connected: true },
        ]),
      ),
    ]),
  ).toBeUndefined()
  expect(
    getWeixinStatusProjection([
      structured(
        "weixin",
        "pi-weixin/status",
        2,
        status([
          { sessionId: "session-a", accountId: "wx-a", connected: true },
          { sessionId: "session-b", accountId: "wx-a", connected: true },
        ]),
      ),
    ]),
  ).toBeUndefined()
})

test("compares Weixin bindings by identity rather than projection order", () => {
  const left = {
    kind: "pi-weixin/status" as const,
    version: 2 as const,
    bindings: [
      { sessionId: "session-a", accountId: "wx-a", connected: true, phase: "Connected" as const },
      { sessionId: "session-b", accountId: "wx-b", connected: false, phase: "Stopped" as const },
    ],
  }
  expect(sameWeixinStatusProjection(left, { ...left, bindings: [...left.bindings].reverse() })).toBe(true)
})

test("derives authorization only from the structured Chrome projection", () => {
  expect(isChromeAuthorized([{ _tag: "Text", key: "chrome", text: "● Chrome (indefinite)" }])).toBe(false)
  const authorized = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 2,
    readiness: "offline",
    authorization: "indefinite",
    connection: "offline",
    bridge: "running",
    requirements: [],
  })
  expect(isChromeAuthorized([structured("chrome", authorized.kind, authorized.version, authorized)])).toBe(true)
  const locked = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 2,
    readiness: "locked",
    authorization: "locked",
    connection: "connected",
    bridge: "running",
    requirements: [],
  })
  expect(isChromeAuthorized([structured("chrome", locked.kind, locked.version, locked)])).toBe(false)
})
