import { Option, Schema } from "effect"

export const PIPEE_PATH_MIME = "application/x-pi-web-path"
export const PIPEE_DIRECTORY_MIME = "application/x-pi-web-directory"

export interface DroppedPath {
  path: string
  isDirectory: boolean
}

export interface DropPayload {
  files: File[]
  paths: DroppedPath[]
  hasDirectory: boolean
}

export interface DropTransferView {
  readonly files: ArrayLike<File>
  readonly types: ArrayLike<string>
  readonly items: ArrayLike<{
    readonly kind: string
    readonly webkitGetAsEntry: () => { readonly isDirectory: boolean } | null
  }>
  readonly getData: (type: string) => string
}

const DroppedPathSchema = Schema.Struct({
  path: Schema.String,
  isDirectory: Schema.Boolean,
})

const decodeDroppedPath = Schema.decodeUnknownOption(Schema.fromJsonString(DroppedPathSchema))

function decodeUriComponent(value: string): string {
  const escaped = value.replace(/\+/g, "%2B").replace(/&/g, "%26").replace(/#/g, "%23")
  const decoded = new URL(`https://pipee.invalid/?value=${escaped}`).searchParams.get("value")
  return decoded === null || decoded.includes("\uFFFD") ? value : decoded
}

function readInternalPath(dataTransfer: DropTransferView): DroppedPath | null {
  const internal = dataTransfer.getData(PIPEE_PATH_MIME)
  if (!internal) return null
  return Option.getOrNull(decodeDroppedPath(internal))
}

function fileUrlToPath(value: string): string | null {
  if (!URL.canParse(value)) return null
  const url = new URL(value)
  return url.protocol === "file:" ? decodeUriComponent(url.pathname) : null
}

export function inspectDrop(dataTransfer: DropTransferView): { hasFiles: boolean; hasDirectory: boolean } {
  const items = Array.from(dataTransfer.items)
  const types = Array.from(dataTransfer.types)
  const internal = readInternalPath(dataTransfer)
  const hasInternalPath = types.includes(PIPEE_PATH_MIME)
  const hasDirectory =
    types.includes(PIPEE_DIRECTORY_MIME) ||
    internal?.isDirectory === true ||
    items.some((item) => item.webkitGetAsEntry()?.isDirectory === true)
  return {
    hasFiles:
      hasInternalPath || hasDirectory || items.some((item) => item.kind === "file") || dataTransfer.files.length > 0,
    hasDirectory,
  }
}

export function readDropPayload(dataTransfer: DropTransferView): DropPayload {
  const files = Array.from(dataTransfer.files)
  const { hasDirectory } = inspectDrop(dataTransfer)
  const paths: DroppedPath[] = []

  const internal = readInternalPath(dataTransfer)
  if (internal) paths.push(internal)

  if (paths.length === 0) {
    const uriList = dataTransfer.getData("text/uri-list")
    for (const line of uriList.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue
      const path = fileUrlToPath(line)
      if (path) paths.push({ path, isDirectory: hasDirectory })
    }
  }

  return { files, paths, hasDirectory }
}

export function writePathDrag(dataTransfer: DataTransfer, path: string, isDirectory: boolean): void {
  dataTransfer.effectAllowed = "copy"
  dataTransfer.setData(PIPEE_PATH_MIME, JSON.stringify({ path, isDirectory } satisfies DroppedPath))
  if (isDirectory) dataTransfer.setData(PIPEE_DIRECTORY_MIME, "1")
  dataTransfer.setData("text/plain", path)
}
