import { expect, test } from "vite-plus/test"
import { renderToStaticMarkup } from "react-dom/server"
import type { PresentationDocument } from "@pipee/companion-contracts/presentation"
import { PresentationSurface } from "./PresentationSurface"

const document: PresentationDocument = {
  contract: "pipee/presentation@1",
  title: "Fixture",
  summary: "Shared semantics",
  tone: "success",
  icon: "extension",
  status: { text: "Ready", tone: "success" },
  body: { type: "field", label: "Owner", value: "fixture" },
}

test("interprets one document in artifact and live modes", () => {
  const artifact = renderToStaticMarkup(<PresentationSurface mode="artifact" document={document} />)
  const live = renderToStaticMarkup(<PresentationSurface mode="live" document={document} />)
  for (const html of [artifact, live]) {
    expect(html).toContain('data-presentation-contract="pipee/presentation@1"')
    expect(html).toContain("Fixture")
    expect(html).toContain("Shared semantics")
    expect(html).toContain("Ready")
  }
  expect(artifact).toContain("fixture")
  expect(live).not.toContain("fixture")
})
