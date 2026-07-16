import { Option } from "effect"
import { expect, test } from "@effect/vitest"
import { ChromeStatusProjection } from "@/api/contract"
import {
  decodeChromeStatusProjection,
  extensionStructuredStatusOrUndefined,
  getLoopStatusProjection,
  getWeixinStatusProjection,
  isChromeAuthorized,
  sameWeixinStatusProjection,
} from "./extension-status"

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
  expect(extensionStructuredStatusOrUndefined(weixin)).toEqual(weixin)
  expect(isChromeAuthorized([{ key: "weixin", status: weixin }])).toBe(false)
  expect(getWeixinStatusProjection([{ key: "weixin", status: weixin }])).toEqual(weixin)
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
  expect(getLoopStatusProjection([{ key: "pi-loop", status: projection }])).toEqual(projection)
  expect(
    getLoopStatusProjection([
      { key: "pi-loop", status: { ...projection, loops: [{ ...projection.loops[0], phase: { _tag: "unknown" } }] } },
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
      {
        key: "weixin",
        status: status([
          { sessionId: "session-a", accountId: "wx-a", connected: true },
          { sessionId: "session-a", accountId: "wx-b", connected: true },
        ]),
      },
    ]),
  ).toBeUndefined()
  expect(
    getWeixinStatusProjection([
      {
        key: "weixin",
        status: status([
          { sessionId: "session-a", accountId: "wx-a", connected: true },
          { sessionId: "session-b", accountId: "wx-a", connected: true },
        ]),
      },
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
  expect(isChromeAuthorized([{ key: "chrome", text: "● Chrome (indefinite)" }])).toBe(false)
  expect(
    isChromeAuthorized([
      {
        key: "chrome",
        status: ChromeStatusProjection.make({
          kind: "pi-chrome/status",
          version: 2,
          readiness: "offline",
          authorization: "indefinite",
          connection: "offline",
          bridge: "running",
          requirements: [],
        }),
      },
    ]),
  ).toBe(true)
  expect(
    isChromeAuthorized([
      {
        key: "chrome",
        status: ChromeStatusProjection.make({
          kind: "pi-chrome/status",
          version: 2,
          readiness: "locked",
          authorization: "locked",
          connection: "connected",
          bridge: "running",
          requirements: [],
        }),
      },
    ]),
  ).toBe(false)
})
