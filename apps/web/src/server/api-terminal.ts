import { Context } from "effect"
import { disposeApi, handleApiRequest } from "@/api/server"

const shutdownController = new AbortController()
let disposePromise: Promise<void> | undefined

export const disposeApiTerminal = (): Promise<void> => {
  shutdownController.abort()
  return (disposePromise ??= disposeApi())
}

export const handleApiTerminalRequest = (request: Request): Promise<Response> =>
  handleApiRequest(request, Context.empty()).then((response) => {
    if (response.body === null) return response
    const body = response.body.pipeThrough(new TransformStream(), {
      signal: AbortSignal.any([request.signal, shutdownController.signal]),
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  })
