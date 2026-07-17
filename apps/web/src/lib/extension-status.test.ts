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
