import { Option, Schema } from "effect"
import type { ExtensionWidgetContent } from "@/api/contract"

const PNG_DATA_URL_PREFIX = "data:image/png;base64,"
const MAX_IMAGE_DATA_URL_LENGTH = 2_000_000
const MAX_IMAGE_DIMENSION = 2048

const ExtensionImageWidgetInput = Schema.Struct({
  dataUrl: Schema.String,
  alt: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
})

export function decodeExtensionImageWidget(input: unknown): Option.Option<ExtensionWidgetContent> {
  const decoded = Schema.decodeUnknownOption(ExtensionImageWidgetInput)(input)
  if (Option.isNone(decoded)) return Option.none()
  const image = decoded.value
  const alt = image.alt.trim()
  if (
    !image.dataUrl.startsWith(PNG_DATA_URL_PREFIX) ||
    image.dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH ||
    alt.length === 0 ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > MAX_IMAGE_DIMENSION ||
    image.height > MAX_IMAGE_DIMENSION
  )
    return Option.none()
  return Option.some({
    kind: "image",
    dataUrl: image.dataUrl,
    alt,
    width: image.width,
    height: image.height,
  })
}
