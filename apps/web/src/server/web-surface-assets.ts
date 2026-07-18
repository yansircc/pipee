import { Context, Effect, FileSystem, Path } from "effect"
import { HttpServerResponse, type HttpServerRequest } from "effect/unstable/http"
import { WebSurfaceCatalog } from "./web-surface-catalog"

const mime = (path: Context.Service.Shape<typeof Path.Path>, file: string): string => {
  const extension = path.extname(file).toLowerCase()
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  )
}

const notFound = () => HttpServerResponse.empty({ status: 404 })

export const webSurfaceAssetHandler = (
  catalog: Context.Service.Shape<typeof WebSurfaceCatalog>,
  fs: Context.Service.Shape<typeof FileSystem.FileSystem>,
  path: Context.Service.Shape<typeof Path.Path>,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const pathname = new URL(request.url, "http://pi-web.local").pathname
    const encoded = pathname.slice("/extension-assets/".length).split("/")
    if (encoded.at(-1) === "") encoded.pop()
    if (encoded.length < 4) return notFound()
    const decoded = yield* Effect.try({
      try: () => ({
        sessionId: decodeURIComponent(encoded[0]!),
        surfaceId: decodeURIComponent(encoded[1]!),
        candidateHash: decodeURIComponent(encoded[2]!),
        asset: encoded.slice(3).map(decodeURIComponent).join("/"),
      }),
      catch: () => null,
    })
    if (decoded === null) return notFound()
    const { sessionId, surfaceId, candidateHash, asset } = decoded
    if (!asset || asset.split("/").some((part) => !part || part === "." || part === "..") || asset.includes("\\")) {
      return notFound()
    }
    const admitted = yield* catalog.read(sessionId).pipe(Effect.option)
    if (admitted._tag === "None") return notFound()
    const surface = admitted.value.admitted.get(surfaceId)
    if (surface === undefined || surface.candidate.candidateHash !== candidateHash) return notFound()
    const relative = `dist/web/${asset}`
    if (!surface.candidate.files.includes(relative)) return notFound()
    const absolute = path.resolve(surface.candidate.webRoot, ...asset.split("/"))
    const resolved = yield* fs.realPath(absolute).pipe(Effect.option)
    if (
      resolved._tag === "None" ||
      (!resolved.value.startsWith(`${surface.candidate.webRoot}${path.sep}`) &&
        resolved.value !== surface.candidate.webRoot)
    ) {
      return notFound()
    }
    const bytes = yield* fs.readFile(resolved.value).pipe(Effect.option)
    if (bytes._tag === "None") return notFound()
    const contentType = mime(path, asset)
    const headers: Record<string, string> = {
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${candidateHash}"`,
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    }
    if (contentType.startsWith("text/html")) {
      const host = request.headers["x-forwarded-host"] ?? request.headers.host
      const protocol = request.headers["x-forwarded-proto"] === "https" ? "https" : "http"
      const assetOrigin = host !== undefined && /^[A-Za-z0-9.:[\]-]+$/.test(host) ? `${protocol}://${host}` : "'self'"
      headers["content-security-policy"] = [
        "default-src 'none'",
        `script-src ${assetOrigin}`,
        `style-src ${assetOrigin} 'unsafe-inline'`,
        `img-src ${assetOrigin} data:`,
        `font-src ${assetOrigin}`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
        "navigate-to 'none'",
      ].join("; ")
    }
    return HttpServerResponse.uint8Array(bytes.value, { contentType, headers })
  })
