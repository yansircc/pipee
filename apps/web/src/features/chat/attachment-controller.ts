import { Effect, Encoding } from "effect"
import { withApi } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"

export interface PreparedImage {
  readonly data: string
  readonly mimeType: string
  readonly previewUrl: string
}

export interface PreparedAttachment {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly mimeType: string
  readonly managed: boolean
}

export interface PreparedDrop {
  readonly images: ReadonlyArray<PreparedImage>
  readonly attachments: ReadonlyArray<PreparedAttachment>
}

export const prepareImages = (files: ReadonlyArray<File>) =>
  Effect.gen(function* () {
    const browser = yield* BrowserPlatform
    return yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const content = yield* browser.readFile(file)
          const previewUrl = yield* browser.createObjectUrl(file)
          return {
            data: Encoding.encodeBase64(content.bytes),
            mimeType: content.mimeType,
            previewUrl,
          }
        }),
      { concurrency: "unbounded" },
    )
  })

export const prepareDrop = (files: ReadonlyArray<File>, paths: ReadonlyArray<string>, cwd: string) =>
  Effect.gen(function* () {
    const browser = yield* BrowserPlatform
    const imageFiles = files.filter((file) => file.type.startsWith("image/"))
    const images = yield* prepareImages(imageFiles)
    const pathAttachments = paths.map(
      (path) =>
        ({
          path,
          name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
          size: 0,
          mimeType: "application/octet-stream",
          managed: false,
        }) satisfies PreparedAttachment,
    )
    if (paths.length > 0) return { images, attachments: pathAttachments }

    const uploadFiles = files.filter((file) => !file.type.startsWith("image/"))
    if (uploadFiles.length === 0) return { images, attachments: pathAttachments }
    const payload = yield* Effect.forEach(
      uploadFiles,
      (file) =>
        browser.readFile(file).pipe(
          Effect.map((content) => ({
            name: content.name,
            mimeType: content.mimeType,
            data: Encoding.encodeBase64(content.bytes),
          })),
        ),
      { concurrency: "unbounded" },
    )
    const stored = yield* withApi((api) => api.workspace.attachments({ payload: { cwd, attachments: payload } }))
    return {
      images,
      attachments: stored.attachments.map((attachment) => ({ ...attachment, managed: true })),
    }
  })
