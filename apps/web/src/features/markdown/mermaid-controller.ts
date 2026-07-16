import { Data, Effect } from "effect"
import { BrowserPlatform } from "@/browser/browser-platform"
import { loadMermaid } from "@/browser/code-split"

export class MermaidRenderError extends Data.TaggedError("MermaidRenderError")<{
  readonly message: string
}> {}

const failure = (cause: unknown) =>
  new MermaidRenderError({
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

export const renderMermaid = (code: string, dark: boolean) =>
  Effect.gen(function* () {
    const browser = yield* BrowserPlatform
    const id = `mermaid-${yield* browser.randomUUID}`
    const mermaid = yield* Effect.tryPromise({
      try: loadMermaid,
      catch: failure,
    })
    yield* Effect.sync(() =>
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: dark ? "dark" : "default",
      }),
    )
    const parsed = yield* Effect.tryPromise({
      try: () => mermaid.parse(code, { suppressErrors: true }),
      catch: failure,
    })
    if (!parsed) return yield* new MermaidRenderError({ message: "Invalid Mermaid diagram" })
    return yield* Effect.tryPromise({
      try: () => mermaid.render(id, code),
      catch: failure,
    })
  })
