import { Context, Data, Duration, Effect, Layer } from "effect"

export class BrowserPlatformError extends Data.TaggedError("BrowserPlatformError")<{
  readonly operation: string
  readonly message: string
}> {}

const failure = (operation: string) => (cause: unknown) =>
  new BrowserPlatformError({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

export interface BrowserFile {
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly bytes: Uint8Array
}

export interface BrowserRect {
  readonly top: number
  readonly left: number
  readonly width: number
}

export interface ChromeExtensionRuntime {
  readonly lastError?: { readonly message?: string }
  readonly sendMessage: (extensionId: string, message: unknown, callback: (response: unknown) => void) => void
}

export class BrowserPlatform extends Context.Service<
  BrowserPlatform,
  {
    readonly readFile: (file: File) => Effect.Effect<BrowserFile, BrowserPlatformError>
    readonly readTextFile: (file: File) => Effect.Effect<string, BrowserPlatformError>
    readonly downloadTextFile: (
      name: string,
      content: string,
      mimeType: string,
    ) => Effect.Effect<void, BrowserPlatformError>
    readonly createObjectUrl: (file: Blob) => Effect.Effect<string, BrowserPlatformError>
    readonly revokeObjectUrl: (url: string) => Effect.Effect<void>
    readonly openExternal: (url: string) => Effect.Effect<void>
    readonly focusAfter: (element: HTMLElement, delay: Duration.Input) => Effect.Effect<void>
    readonly nextAnimationFrame: Effect.Effect<void>
    readonly viewportHeight: Effect.Effect<number>
    readonly measure: (element: Element) => Effect.Effect<BrowserRect>
    readonly onDocumentMouseDown: (listener: (event: MouseEvent) => void) => Effect.Effect<never>
    readonly onDocumentKeyDown: (listener: (event: KeyboardEvent) => void) => Effect.Effect<never>
    readonly observeResize: (elements: ReadonlyArray<Element>, listener: () => void) => Effect.Effect<never>
    readonly onElementScroll: (element: Element, listener: () => void) => Effect.Effect<never>
    readonly watchElementNearViewportEnd: (
      container: Element,
      target: Element,
      tolerance: number,
      listener: (nearEnd: boolean) => void,
    ) => Effect.Effect<never>
    readonly scrollElementIntoView: (
      element: Element,
      behavior: ScrollBehavior,
    ) => Effect.Effect<void, BrowserPlatformError>
    readonly onWindowMouseDrag: (onMove: (event: MouseEvent) => void, onEnd: () => void) => Effect.Effect<void>
    readonly watchMediaQuery: (query: string, onChange: (matches: boolean) => void) => Effect.Effect<never>
    readonly navigate: (url: string) => Effect.Effect<void>
    readonly writeClipboard: (text: string) => Effect.Effect<void, BrowserPlatformError>
    readonly unlockAudio: Effect.Effect<void, BrowserPlatformError>
    readonly playDoneSound: Effect.Effect<void, BrowserPlatformError>
    readonly randomUUID: Effect.Effect<string, BrowserPlatformError>
    readonly sendChromeExtensionMessage: (
      extensionId: string,
      message: unknown,
    ) => Effect.Effect<unknown, BrowserPlatformError>
  }
>()("pi-web/browser/BrowserPlatform") {}

let sharedAudioContext: AudioContext | null = null

const getAudioContext = Effect.try({
  try: () => {
    if (sharedAudioContext !== null && sharedAudioContext.state !== "closed") return sharedAudioContext
    sharedAudioContext = new AudioContext()
    return sharedAudioContext
  },
  catch: failure("audio.create"),
})

const resumeAudio = (context: AudioContext) =>
  context.state === "suspended"
    ? Effect.tryPromise({ try: () => context.resume(), catch: failure("audio.resume") })
    : Effect.void

const playTone = (context: AudioContext) =>
  Effect.try({
    try: () => {
      const now = context.currentTime
      const frequencies = [523.25, 659.25]
      frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.type = "sine"
        oscillator.frequency.value = frequency
        const start = now + index * 0.18
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(0.18, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45)
        oscillator.start(start)
        oscillator.stop(start + 0.45)
      })
    },
    catch: failure("audio.play"),
  })

export const BrowserPlatformLive = Layer.succeed(BrowserPlatform, {
  readFile: (file) =>
    Effect.tryPromise({
      try: () => file.arrayBuffer(),
      catch: failure("file.read"),
    }).pipe(
      Effect.map((buffer) => ({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        bytes: new Uint8Array(buffer),
      })),
    ),
  readTextFile: (file) =>
    Effect.tryPromise({
      try: () => file.text(),
      catch: failure("file.read-text"),
    }),
  downloadTextFile: (name, content, mimeType) =>
    Effect.acquireUseRelease(
      Effect.try({
        try: () => URL.createObjectURL(new Blob([content], { type: mimeType })),
        catch: failure("file.download-text.create"),
      }),
      (url) =>
        Effect.try({
          try: () => {
            const link = document.createElement("a")
            link.href = url
            link.download = name
            link.click()
          },
          catch: failure("file.download-text.click"),
        }),
      (url) => Effect.sync(() => URL.revokeObjectURL(url)),
    ),
  createObjectUrl: (file) =>
    Effect.try({
      try: () => URL.createObjectURL(file),
      catch: failure("object-url.create"),
    }),
  revokeObjectUrl: (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  openExternal: (url) =>
    Effect.sync(() => {
      window.open(url, "_blank", "noopener,noreferrer")
    }),
  focusAfter: (element, delay) => Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(() => element.focus()))),
  nextAnimationFrame: Effect.callback<void>((resume) => {
    const id = requestAnimationFrame(() => resume(Effect.void))
    return Effect.sync(() => cancelAnimationFrame(id))
  }),
  viewportHeight: Effect.sync(() => window.visualViewport?.height ?? window.innerHeight),
  measure: (element) =>
    Effect.sync(() => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, left: rect.left, width: rect.width }
    }),
  onDocumentMouseDown: (listener) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => document.addEventListener("mousedown", listener)),
        () => Effect.sync(() => document.removeEventListener("mousedown", listener)),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  onDocumentKeyDown: (listener) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => document.addEventListener("keydown", listener)),
        () => Effect.sync(() => document.removeEventListener("keydown", listener)),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  observeResize: (elements, listener) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          const observer = new ResizeObserver(listener)
          for (const element of elements) observer.observe(element)
          listener()
          return observer
        }),
        (observer) => Effect.sync(() => observer.disconnect()),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  onElementScroll: (element, listener) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => element.addEventListener("scroll", listener, { passive: true })),
        () => Effect.sync(() => element.removeEventListener("scroll", listener)),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  watchElementNearViewportEnd: (container, target, tolerance, listener) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          const update = () => {
            const viewport = container.getBoundingClientRect()
            const latest = target.getBoundingClientRect()
            listener(latest.bottom <= viewport.bottom + tolerance)
          }
          container.addEventListener("scroll", update, { passive: true })
          return update
        }),
        (update) => Effect.sync(() => container.removeEventListener("scroll", update)),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  scrollElementIntoView: (element, behavior) =>
    Effect.try({
      try: () => element.scrollIntoView({ behavior, block: "end" }),
      catch: failure("element.scroll-into-view"),
    }),
  onWindowMouseDrag: (onMove, onEnd) =>
    Effect.callback<void>((resume) => {
      const end = () => {
        onEnd()
        resume(Effect.void)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", end, { once: true })
      return Effect.sync(() => {
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", end)
      })
    }),
  watchMediaQuery: (query, onChange) =>
    Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          const media = window.matchMedia(query)
          const update = () => onChange(media.matches)
          media.addEventListener("change", update)
          update()
          return { media, update }
        }),
        ({ media, update }) => Effect.sync(() => media.removeEventListener("change", update)),
      ).pipe(Effect.andThen(Effect.never)),
    ),
  navigate: (url) =>
    Effect.sync(() => {
      window.location.href = url
    }),
  writeClipboard: (text) =>
    Effect.tryPromise({
      try: () => navigator.clipboard.writeText(text),
      catch: failure("clipboard.write"),
    }),
  unlockAudio: getAudioContext.pipe(Effect.flatMap(resumeAudio)),
  playDoneSound: getAudioContext.pipe(
    Effect.flatMap((context) => resumeAudio(context).pipe(Effect.andThen(playTone(context)))),
  ),
  randomUUID: Effect.try({
    try: () => crypto.randomUUID(),
    catch: failure("crypto.random-uuid"),
  }),
  sendChromeExtensionMessage: (extensionId, message) =>
    Effect.callback((resume) => {
      const runtime = (
        globalThis as typeof globalThis & {
          readonly chrome?: { readonly runtime?: ChromeExtensionRuntime }
        }
      ).chrome?.runtime
      if (runtime === undefined) {
        resume(
          Effect.fail(
            new BrowserPlatformError({
              operation: "chrome-extension.message",
              message: "Chrome extension messaging is unavailable in this browser profile",
            }),
          ),
        )
        return
      }
      runtime.sendMessage(extensionId, message, (response) => {
        const message = runtime.lastError?.message
        resume(
          message === undefined
            ? Effect.succeed(response)
            : Effect.fail(new BrowserPlatformError({ operation: "chrome-extension.message", message })),
        )
      })
    }),
})
