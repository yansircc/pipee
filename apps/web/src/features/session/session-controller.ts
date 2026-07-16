import { Effect, Stream } from "effect"
import { withApi } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import type {
  ChromeControlRequestType,
  ExtensionInteractionResponse,
  LoopControlRequestType,
  RuntimeId,
  RuntimeEnvelope,
  SessionSnapshot,
  WeixinControlRequestType,
} from "@/api/contract"

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return String(error)
}

export const loadSessionSnapshot = (sessionId: string) =>
  withApi((api) =>
    api.sessions.snapshot({
      params: { id: sessionId },
      query: { deferThinking: "1", deferMedia: "1" },
    }),
  )

export const observeSession = (
  sessionId: string,
  callbacks: {
    readonly onEvent: (event: RuntimeEnvelope) => void
    readonly onSnapshotStarted: () => number
    readonly onSnapshot: (snapshot: SessionSnapshot, requestId: number) => void
    readonly onTransientError: (message: string) => void
  },
) => {
  const loadSnapshot = Effect.suspend(() => {
    const requestId = callbacks.onSnapshotStarted()
    return loadSessionSnapshot(sessionId).pipe(
      Effect.tap((snapshot) => Effect.sync(() => callbacks.onSnapshot(snapshot, requestId))),
    )
  })
  const events = loadSnapshot.pipe(
    Effect.andThen(Effect.suspend(() => withApi((api) => api.sessions.events({ params: { id: sessionId } })))),
    Effect.flatMap((stream) => stream.pipe(Stream.runForEach((event) => Effect.sync(() => callbacks.onEvent(event))))),
    Effect.catch((error) => Effect.sync(() => callbacks.onTransientError(errorMessage(error)))),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  )
  const reconcile = Effect.sleep("15 seconds").pipe(
    Effect.andThen(loadSnapshot),
    Effect.catch((error) => Effect.sync(() => callbacks.onTransientError(errorMessage(error)))),
    Effect.forever,
  )
  return Effect.all([events, reconcile], { concurrency: "unbounded", discard: true })
}

export const observeRunningSessions = (callbacks: {
  readonly onSnapshot: (sessionIds: ReadonlyArray<string>) => void
  readonly onTransientError: (message: string) => void
}) => {
  const publish = (sessionIds: ReadonlyArray<string>) => Effect.sync(() => callbacks.onSnapshot(sessionIds))
  const events = Effect.suspend(() => withApi((api) => api.sessions.runningEvents({}))).pipe(
    Effect.flatMap((stream) => stream.pipe(Stream.runForEach((event) => publish(event.sessionIds)))),
    Effect.catch((error) => Effect.sync(() => callbacks.onTransientError(errorMessage(error)))),
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
  )
  return events
}

const weixinControl = (sessionId: string, payload: WeixinControlRequestType) =>
  withApi((api) => api.sessionActions.weixinControl({ params: { id: sessionId }, payload }))

const chromeControl = (sessionId: string, payload: ChromeControlRequestType) =>
  withApi((api) => api.sessionActions.chromeControl({ params: { id: sessionId }, payload }))

const resolveInteraction = (
  sessionId: string,
  runtimeId: RuntimeId,
  interactionId: string,
  payload: ExtensionInteractionResponse,
) =>
  withApi((api) =>
    api.sessionActions.resolveInteraction({ params: { id: sessionId, runtimeId, interactionId }, payload }),
  )

export const sessionController = {
  nextPromptRequestId: Effect.gen(function* () {
    const browser = yield* BrowserPlatform
    return yield* browser.randomUUID
  }),
  create: (cwd: string, toolNames?: ReadonlyArray<string>) =>
    withApi((api) =>
      api.sessions.create({
        payload: { cwd, ...(toolNames === undefined ? {} : { toolNames }) },
      }),
    ),
  createConfigured: (
    cwd: string,
    toolNames: ReadonlyArray<string>,
    model: { readonly provider: string; readonly modelId: string } | null,
  ) =>
    withApi((api) => api.sessions.create({ payload: { cwd, toolNames } })).pipe(
      Effect.flatMap((session) =>
        model === null
          ? Effect.succeed(session)
          : withApi((api) =>
              api.sessionActions.setModel({
                params: { id: session.id },
                payload: { provider: model.provider, modelId: model.modelId },
              }),
            ).pipe(Effect.as(session)),
      ),
    ),
  rename: (sessionId: string, name: string) =>
    withApi((api) =>
      api.sessions.rename({
        params: { id: sessionId },
        payload: { name },
      }),
    ),
  prompt: (
    sessionId: string,
    requestId: string,
    message: string,
    images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>,
  ) =>
    withApi((api) =>
      api.sessionActions.prompt({
        params: { id: sessionId },
        payload: {
          requestId,
          message,
          ...(images === undefined ? {} : { images }),
        },
      }),
    ),
  steer: (
    sessionId: string,
    message: string,
    images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>,
  ) =>
    withApi((api) =>
      api.sessionActions.steer({
        params: { id: sessionId },
        payload: { message, ...(images === undefined ? {} : { images }) },
      }),
    ),
  followUp: (
    sessionId: string,
    message: string,
    images?: ReadonlyArray<{ readonly type: "image"; readonly data: string; readonly mimeType: string }>,
  ) =>
    withApi((api) =>
      api.sessionActions.followUp({
        params: { id: sessionId },
        payload: { message, ...(images === undefined ? {} : { images }) },
      }),
    ),
  abort: (sessionId: string) => withApi((api) => api.sessionActions.abort({ params: { id: sessionId }, payload: {} })),
  abortBash: (sessionId: string) =>
    withApi((api) => api.sessionActions.abortBash({ params: { id: sessionId }, payload: {} })),
  bash: (sessionId: string, id: string, command: string, excludeFromContext: boolean) =>
    withApi((api) =>
      api.sessionActions.bash({
        params: { id: sessionId },
        payload: { id, command, excludeFromContext },
      }),
    ),
  fork: (sessionId: string, entryId: string) =>
    withApi((api) =>
      api.sessionActions.fork({
        params: { id: sessionId },
        payload: { entryId },
      }),
    ),
  navigate: (sessionId: string, targetId: string) =>
    withApi((api) =>
      api.sessionActions.navigate({
        params: { id: sessionId },
        payload: { targetId },
      }),
    ),
  context: (sessionId: string, leafId: string | undefined) =>
    withApi((api) =>
      api.sessions.context({
        params: { id: sessionId },
        query: {
          ...(leafId === undefined ? {} : { leafId }),
          deferThinking: "1",
          deferMedia: "1",
        },
      }),
    ),
  compact: (sessionId: string, customInstructions?: string) =>
    withApi((api) =>
      api.sessionActions.compact({
        params: { id: sessionId },
        payload: customInstructions === undefined ? {} : { customInstructions },
      }),
    ),
  abortCompaction: (sessionId: string) =>
    withApi((api) =>
      api.sessionActions.abortCompaction({
        params: { id: sessionId },
        payload: {},
      }),
    ),
  setModel: (sessionId: string, provider: string, modelId: string) =>
    withApi((api) =>
      api.sessionActions.setModel({
        params: { id: sessionId },
        payload: { provider, modelId },
      }),
    ),
  setThinking: (sessionId: string, level: string) =>
    withApi((api) =>
      api.sessionActions.setThinking({
        params: { id: sessionId },
        payload: { level },
      }),
    ),
  setTools: (sessionId: string, toolNames: ReadonlyArray<string>) =>
    withApi((api) =>
      api.sessionActions.setTools({
        params: { id: sessionId },
        payload: { toolNames },
      }),
    ),
  tools: (sessionId: string) => withApi((api) => api.sessionActions.tools({ params: { id: sessionId } })),
  commands: (sessionId: string) => withApi((api) => api.sessionActions.commands({ params: { id: sessionId } })),
  stats: (sessionId: string) => withApi((api) => api.sessionActions.stats({ params: { id: sessionId } })),
  lastAssistant: (sessionId: string) =>
    withApi((api) => api.sessionActions.lastAssistant({ params: { id: sessionId } })),
  clearQueue: (sessionId: string) =>
    withApi((api) => api.sessionActions.clearQueue({ params: { id: sessionId }, payload: {} })),
  reload: (sessionId: string) =>
    withApi((api) => api.sessionActions.reload({ params: { id: sessionId }, payload: {} })),
  slashCommand: (sessionId: string, name: string, args: string) =>
    withApi((api) => api.sessionActions.slashCommand({ params: { id: sessionId }, payload: { name, args } })),
  loopControl: (sessionId: string, payload: LoopControlRequestType) =>
    withApi((api) =>
      api.sessionActions.loopControl({
        params: { id: sessionId },
        payload,
      }),
    ),
  weixinControl,
  chromeControl,
  resolveInteraction,
  modelCatalog: (cwd: string) => withApi((api) => api.models.catalog({ query: { cwd } })),
  plugins: (cwd: string) => withApi((api) => api.packages.plugins({ query: { cwd } })),
}
