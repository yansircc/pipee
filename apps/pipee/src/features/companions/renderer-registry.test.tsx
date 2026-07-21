import { expect, test } from "vite-plus/test"
import { renderToStaticMarkup } from "react-dom/server"
import { ExtensionStatusContribution, type JsonValue } from "@/api/contract"
import { CompanionRendererRegistry, companionRendererKeys, inspectCompanionContribution } from "./renderer-registry"

const structured = (kind: string, version: number, value: JsonValue) => {
  const contribution = ExtensionStatusContribution.make({ _tag: "Structured", key: "status", kind, version, value })
  if (contribution._tag !== "Structured") throw new globalThis.Error("Expected structured contribution")
  return contribution
}

test("registers each known companion discriminator exactly once", () => {
  expect(companionRendererKeys).toEqual(["pi-loop/status@1", "pi-weixin/status@3", "pi-chrome/status@3"])
  expect(new Set(companionRendererKeys).size).toBe(companionRendererKeys.length)
})

test("separates known, incompatible, and unknown companion projections", () => {
  expect(
    inspectCompanionContribution(
      structured("pi-weixin/status", 3, {
        kind: "pi-weixin/status",
        version: 3,
        enabled: true,
        connected: true,
        phase: "Connected",
        sendReady: true,
      }),
    ),
  ).toBe("known")
  expect(inspectCompanionContribution(structured("pi-weixin/status", 3, { missing: "phase" }))).toBe("incompatible")
  expect(inspectCompanionContribution(structured("third-party/status", 1, { state: "ready" }))).toBe("unknown")
})

test("renders explicit incompatible and unknown fallbacks", () => {
  const html = renderToStaticMarkup(
    <CompanionRendererRegistry
      statuses={[
        structured("pi-weixin/status", 3, { missing: "phase" }),
        structured("third-party/status", 1, { state: "ready" }),
      ]}
      sessionId="session-1"
    />,
  )
  expect(html).toContain('data-companion-renderer="incompatible"')
  expect(html).toContain('data-companion-renderer="unknown"')
})
