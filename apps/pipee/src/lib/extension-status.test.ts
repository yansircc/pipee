import { Option } from "effect"
import { expect, test } from "@effect/vitest"
import { ChromeStatusProjection, ExtensionStatusContribution, type JsonValue } from "@/api/contract"
import {
  decodeChromeStatusProjection,
  extensionStructuredStatusOrUndefined,
  getChromeStatusProjection,
  getLoopStatusProjection,
  getWeixinStatusProjection,
  sameWeixinStatusProjection,
} from "./extension-status"

const structured = (key: string, kind: string, version: number, value: JsonValue) =>
  ExtensionStatusContribution.make({ _tag: "Structured", key, kind, version, value })

test("decodes the pi-chrome readiness projection without interpreting display text", () => {
  const status = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 3,
    state: "ready",
    bridge: "running",
    connector: { id: "personal", label: "Personal", connected: true, lastSeenAt: 123_000 },
    extensionDirectory: "/tmp/pi-chrome",
  })
  expect(Option.getOrNull(decodeChromeStatusProjection(status))).toEqual(status)
})

test("rejects incomplete or unknown status projections", () => {
  expect(Option.isNone(decodeChromeStatusProjection({ kind: "pi-chrome/status", version: 3 }))).toBe(true)
  expect(
    Option.isNone(
      decodeChromeStatusProjection({
        kind: "pi-chrome/status",
        version: 3,
        state: "ready",
        bridge: "mystery",
        extensionDirectory: "/tmp/pi-chrome",
      }),
    ),
  ).toBe(true)
})

test("preserves extension-owned JSON status projections without treating them as Chrome", () => {
  const weixin = {
    kind: "pi-weixin/status",
    version: 3,
    enabled: true,
    connected: true,
    phase: "Connected" as const,
    sendReady: true,
    accountId: "wx-a",
    defaultSessionId: "session-a",
  }
  expect(extensionStructuredStatusOrUndefined(weixin)).toEqual({
    kind: "pi-weixin/status",
    version: 3,
    value: weixin,
  })
  expect(getChromeStatusProjection([structured("weixin", weixin.kind, weixin.version, weixin)])).toBeUndefined()
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

test("rejects incomplete global Weixin projections", () => {
  expect(
    getWeixinStatusProjection([
      structured("weixin", "pi-weixin/status", 3, {
        kind: "pi-weixin/status",
        version: 3,
        connected: true,
      }),
    ]),
  ).toBeUndefined()
})

test("compares global Weixin status fields", () => {
  const left = {
    kind: "pi-weixin/status" as const,
    version: 3 as const,
    enabled: true,
    connected: true,
    phase: "Connected" as const,
    sendReady: true,
    accountId: "wx-a",
    defaultSessionId: "session-a",
  }
  expect(sameWeixinStatusProjection(left, { ...left })).toBe(true)
  expect(sameWeixinStatusProjection(left, { ...left, defaultSessionId: "session-b" })).toBe(false)
})

test("derives Chrome readiness only from the structured Chrome projection", () => {
  expect(getChromeStatusProjection([{ _tag: "Text", key: "chrome", text: "● Chrome ready" }])).toBeUndefined()
  const ready = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 3,
    state: "ready",
    bridge: "running",
    connector: { id: "personal", label: "Personal", connected: true },
    extensionDirectory: "/tmp/pi-chrome",
  })
  expect(getChromeStatusProjection([structured("chrome", ready.kind, ready.version, ready)])).toEqual(ready)
  const waiting = ChromeStatusProjection.make({
    kind: "pi-chrome/status",
    version: 3,
    state: "waiting-for-extension",
    bridge: "running",
    extensionDirectory: "/tmp/pi-chrome",
  })
  expect(getChromeStatusProjection([structured("chrome", waiting.kind, waiting.version, waiting)])).toEqual(waiting)
})
