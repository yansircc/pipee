import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  WEB_SURFACE_CHANNEL_CONTRACT,
  WebSurfaceClientMessage,
  WebSurfaceHostMessage,
} from "@pipee/companion-contracts/web-surface"

describe("multi-Session Web Surface channel contract", () => {
  it("requires dispatch to name its owning Session", () => {
    expect(
      Schema.decodeUnknownSync(WebSurfaceClientMessage)({
        _tag: "dispatch",
        requestId: "request-1",
        sessionId: "session-1",
        payload: { _tag: "RunNow", id: "loop-1" },
      }),
    ).toMatchObject({ sessionId: "session-1" })
    expect(() =>
      Schema.decodeUnknownSync(WebSurfaceClientMessage)({
        _tag: "dispatch",
        requestId: "request-1",
        payload: null,
      }),
    ).toThrow()
  })

  it("carries Session context with every initial projection", () => {
    expect(
      Schema.decodeUnknownSync(WebSurfaceHostMessage)({
        _tag: "init",
        contract: WEB_SURFACE_CHANNEL_CONTRACT,
        session: {
          sessionId: "session-1",
          cwd: "/workspace",
          name: "Release check",
          projectRoot: "/workspace",
          modified: "2026-01-01T00:00:00.000Z",
        },
        runtime: { registryId: "registry", runtimeEpoch: 1, runtimeId: "runtime" },
        surface: {
          packageName: "@yansircc/pi-loop",
          surfaceId: "QHlhbnNpcmNjL3BpLWxvb3A",
          candidateHash: "a".repeat(64),
          revision: 1,
          view: null,
        },
      }),
    ).toMatchObject({ session: { sessionId: "session-1" } })
  })

  it("exposes candidate-bound companion actions without accepting paths or extension ids", () => {
    expect(
      Schema.decodeUnknownSync(WebSurfaceClientMessage)({
        _tag: "browser-companion-probe",
        requestId: "probe-1",
      }),
    ).toEqual({ _tag: "browser-companion-probe", requestId: "probe-1" })
    expect(() =>
      Schema.decodeUnknownSync(WebSurfaceClientMessage, { onExcessProperty: "error" })({
        _tag: "browser-companion-download",
        requestId: "download-1",
        extensionId: "attacker-controlled",
        path: "/tmp/other-extension",
      }),
    ).toThrow()
  })
})
