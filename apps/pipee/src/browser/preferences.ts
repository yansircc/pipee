import { Context, Data, Effect, Layer, Schema } from "effect"
import { AtomRef } from "effect/unstable/reactivity"

export const Locale = Schema.Literals(["zh-CN", "en"])
export type Locale = typeof Locale.Type

export const Theme = Schema.Literals(["light", "dark"])
export type Theme = typeof Theme.Type

export const ChatDraftImage = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
})

export const ChatDraftAttachment = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  mimeType: Schema.String,
  managed: Schema.Boolean,
})

export const ChatDraft = Schema.Struct({
  value: Schema.String,
  images: Schema.Array(ChatDraftImage),
  attachments: Schema.Array(ChatDraftAttachment),
})

export const BrowserPreferencesState = Schema.Struct({
  version: Schema.Literal(2),
  locale: Locale,
  theme: Theme,
  soundEnabled: Schema.Boolean,
  unreadSessionIds: Schema.Array(Schema.String),
  drafts: Schema.Record(Schema.String, ChatDraft),
})

export type BrowserPreferencesState = typeof BrowserPreferencesState.Type

const STORAGE_KEY = "pipee:preferences:v2"

export const defaultBrowserPreferences: BrowserPreferencesState = BrowserPreferencesState.make({
  version: 2,
  locale: "zh-CN",
  theme: "light",
  soundEnabled: true,
  unreadSessionIds: [],
  drafts: {},
})

export const browserPreferencesRef = AtomRef.make<BrowserPreferencesState>(defaultBrowserPreferences)

export class BrowserPreferencesError extends Data.TaggedError("BrowserPreferencesError")<{
  readonly operation: string
  readonly message: string
}> {}

const storageError = (operation: string) => (cause: unknown) =>
  new BrowserPreferencesError({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
  })

const applyDocumentPreferences = (preferences: BrowserPreferencesState) =>
  Effect.sync(() => {
    document.documentElement.lang = preferences.locale
    document.documentElement.classList.toggle("dark", preferences.theme === "dark")
  })

export const decodeBrowserPreferences = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: storageError("preferences.parse"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BrowserPreferencesState)),
    Effect.mapError(storageError("preferences.decode")),
  )

const readStored = Effect.try({
  try: () => localStorage.getItem(STORAGE_KEY),
  catch: storageError("preferences.read"),
}).pipe(
  Effect.flatMap((raw) =>
    raw === null
      ? Effect.succeed(defaultBrowserPreferences)
      : decodeBrowserPreferences(raw).pipe(Effect.catch(() => Effect.succeed(defaultBrowserPreferences))),
  ),
  Effect.catch(() => Effect.succeed(defaultBrowserPreferences)),
)

const persist = (preferences: BrowserPreferencesState) =>
  Effect.try({
    try: () => localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)),
    catch: storageError("preferences.write"),
  })

export class BrowserPreferences extends Context.Service<
  BrowserPreferences,
  {
    readonly initialize: Effect.Effect<void>
    readonly update: (
      transform: (current: BrowserPreferencesState) => BrowserPreferencesState,
    ) => Effect.Effect<void, BrowserPreferencesError>
  }
>()("pipee/browser/BrowserPreferences") {}

export const BrowserPreferencesLive = Layer.succeed(BrowserPreferences, {
  initialize: readStored.pipe(
    Effect.tap((preferences) => Effect.sync(() => browserPreferencesRef.set(preferences))),
    Effect.tap(applyDocumentPreferences),
    Effect.asVoid,
  ),
  update: (transform) =>
    Effect.gen(function* () {
      const next = BrowserPreferencesState.make(transform(browserPreferencesRef.value))
      yield* persist(next)
      yield* Effect.sync(() => browserPreferencesRef.set(next))
      yield* applyDocumentPreferences(next)
    }),
})
