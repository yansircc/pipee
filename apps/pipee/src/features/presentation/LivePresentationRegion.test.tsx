import { expect, test } from "vite-plus/test"
import { renderToStaticMarkup } from "react-dom/server"
import { LivePresentationItem } from "@/api/contract"
import { LivePresentationRegion } from "./LivePresentationRegion"

const presentation = (key: string, title: string) =>
  LivePresentationItem.make({
    key,
    document: {
      contract: "pipee/presentation@1",
      title,
      summary: `${title} summary`,
      tone: "success",
      icon: "extension",
      status: { text: "Ready", tone: "success" },
      body: { type: "field", label: "Owner", value: key },
    },
  })

test("renders owner-bound live presentations through one compact interpreter", () => {
  const html = renderToStaticMarkup(
    <LivePresentationRegion
      presentations={[presentation('["alpha","status"]', "Alpha"), presentation('["beta","status"]', "Beta")]}
    />,
  )
  expect(html).toContain('class="companion-status-grid"')
  expect(html.match(/data-presentation-contract="pipee\/presentation@1"/g)).toHaveLength(2)
  expect(html).toContain("Alpha summary")
  expect(html).toContain("Beta summary")
  expect(html).not.toContain("alpha/status")
})

test("renders nothing when no extension explicitly publishes a presentation", () => {
  expect(renderToStaticMarkup(<LivePresentationRegion presentations={[]} />)).toBe("")
})
