import { expect, test } from "vite-plus/test"
import { renderToStaticMarkup } from "react-dom/server"
import { ExtensionStatusContribution, type JsonValue } from "@/api/contract"
import { CompanionRendererRegistry, inspectCompanionContribution } from "./renderer-registry"

const structured = (kind: string, version: number, value: JsonValue) => {
  const contribution = ExtensionStatusContribution.make({ _tag: "Structured", key: "status", kind, version, value })
  if (contribution._tag !== "Structured") throw new globalThis.Error("Expected structured contribution")
  return contribution
}

const view = (overrides: Record<string, JsonValue> = {}) => ({
  contract: "pipee/companion-view@1",
  label: "Extension",
  state: "Ready",
  summary: "Connected",
  tone: "success",
  glyph: "extension",
  ...overrides,
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
        pipeeCompanionView: view(),
      }),
    ),
  ).toBe("known")
  expect(
    inspectCompanionContribution(
      structured("pi-weixin/status", 3, { pipeeCompanionView: view({ glyph: "unsupported" }) }),
    ),
  ).toBe("incompatible")
  expect(inspectCompanionContribution(structured("third-party/status", 1, { state: "ready" }))).toBe("unknown")
})

test("renders explicit incompatible and unknown fallbacks", () => {
  const html = renderToStaticMarkup(
    <CompanionRendererRegistry
      statuses={[
        structured("pi-weixin/status", 3, { pipeeCompanionView: view({ glyph: "unsupported" }) }),
        structured("third-party/status", 1, { state: "ready" }),
      ]}
      sessionId="session-1"
    />,
  )
  expect(html).toContain('data-companion-renderer="incompatible"')
  expect(html).toContain('data-companion-renderer="unknown"')
})

test("renders known companion statuses through the shared compact surface", () => {
  const html = renderToStaticMarkup(
    <CompanionRendererRegistry
      statuses={[
        structured("pi-weixin/status", 3, {
          kind: "pi-weixin/status",
          version: 3,
          enabled: true,
          connected: true,
          phase: "Connected",
          sendReady: true,
          accountId: "wx-a",
          defaultSessionId: "session-1",
          pipeeCompanionView: view({ label: "Weixin", state: "已连接", summary: "wx-a", glyph: "messages" }),
        }),
        structured("pi-chrome/status", 3, {
          kind: "pi-chrome/status",
          version: 3,
          state: "ready",
          bridge: "running",
          connector: { id: "profile-a", label: "Chrome profile", connected: true },
          extensionDirectory: "/tmp/chrome",
          pipeeCompanionView: view({ label: "Chrome", summary: "Chrome profile", glyph: "browser" }),
        }),
      ]}
      sessionId="session-1"
    />,
  )
  expect(html).toContain('class="companion-status-grid"')
  expect(html.match(/data-companion-renderer="pipee\/companion-view@1"/g)).toHaveLength(2)
  expect(html).toContain("已连接")
  expect(html).toContain("Chrome profile")
})
