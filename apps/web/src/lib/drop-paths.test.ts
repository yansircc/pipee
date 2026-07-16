import assert from "node:assert/strict"
import { test } from "vite-plus/test"
import {
  inspectDrop,
  PI_WEB_DIRECTORY_MIME,
  PI_WEB_PATH_MIME,
  readDropPayload,
  type DropTransferView,
} from "./drop-paths"

function transfer({
  internal = "",
  uri = "",
  directory = false,
  files = [],
}: {
  readonly internal?: string
  readonly uri?: string
  readonly directory?: boolean
  readonly files?: ReadonlyArray<File>
} = {}): DropTransferView {
  return {
    files,
    types: internal ? [PI_WEB_PATH_MIME, ...(directory ? [PI_WEB_DIRECTORY_MIME] : [])] : ["Files"],
    items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: directory }) }],
    getData(type) {
      if (type === PI_WEB_PATH_MIME) return internal
      if (type === "text/uri-list") return uri
      return ""
    },
  }
}

test("reads the app-owned absolute path contract", () => {
  const data = transfer({ internal: JSON.stringify({ path: "/tmp/report.xlsx", isDirectory: false }) })
  assert.deepEqual(readDropPayload(data).paths, [{ path: "/tmp/report.xlsx", isDirectory: false }])
})

test("decodes file URI paths without guessing missing paths", () => {
  const data = transfer({ uri: "file:///Users/example/My%20Project", directory: true })
  assert.deepEqual(readDropPayload(data).paths, [{ path: "/Users/example/My Project", isDirectory: true }])
  assert.deepEqual(inspectDrop(data), { hasFiles: true, hasDirectory: true })
  assert.deepEqual(readDropPayload(transfer({ directory: true })).paths, [])
})
