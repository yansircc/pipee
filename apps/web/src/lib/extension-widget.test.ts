import { Option } from "effect"
import { expect, test } from "@effect/vitest"
import { decodeExtensionImageWidget } from "./extension-widget"

test("accepts bounded PNG image widgets", () => {
  expect(
    Option.getOrNull(
      decodeExtensionImageWidget({
        dataUrl: "data:image/png;base64,AAAA",
        alt: "QR code",
        width: 384,
        height: 384,
      }),
    ),
  ).toEqual({
    kind: "image",
    dataUrl: "data:image/png;base64,AAAA",
    alt: "QR code",
    width: 384,
    height: 384,
  })
})

test.each([
  { dataUrl: "data:image/svg+xml;base64,AAAA", alt: "QR", width: 384, height: 384 },
  { dataUrl: "https://example.com/qr.png", alt: "QR", width: 384, height: 384 },
  { dataUrl: "data:image/png;base64,AAAA", alt: "QR", width: 0, height: 384 },
])("rejects invalid extension image widget %#", (input) => {
  expect(Option.isNone(decodeExtensionImageWidget(input))).toBe(true)
})
