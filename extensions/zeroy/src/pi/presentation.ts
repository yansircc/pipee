import type { PresentationDocument } from "@pipee/companion-contracts/presentation";

export const zeroYPresentation = (
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  tone: PresentationDocument["tone"] = "info",
): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title,
  summary,
  tone,
  icon: "extension",
  body: {
    type: "group",
    direction: "column",
    gap: "small",
    children: fields.map(([label, value]) => ({ type: "field", label, value })),
  },
});
