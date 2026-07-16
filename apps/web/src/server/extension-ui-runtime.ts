import {
  ExtensionStatusContribution,
  ExtensionUiProjection,
  ExtensionWidgetItem,
  SessionScopedEvent,
  type ExtensionInteraction as ExtensionInteractionValue,
  type ExtensionInteractionAnswer as ExtensionInteractionAnswerValue,
  type ExtensionInteractionResponse as ExtensionInteractionResponseValue,
} from "@/api/contract"
import { extensionStructuredStatusOrUndefined } from "@/lib/extension-status"
import { decodeExtensionImageWidget } from "@/lib/extension-widget"
import { Cause, Context, Crypto, Data, Deferred, Effect, Exit, FiberSet, Option, Semaphore } from "effect"
import { makeRuntimeRetention } from "./runtime-retention"

export class PiInteractionConflictError extends Data.TaggedError("PiInteractionConflictError")<{
  readonly interactionId: string
}> {}

export class PiInteractionResponseError extends Data.TaggedError("PiInteractionResponseError")<{
  readonly interactionId: string
  readonly method: ExtensionInteractionValue["method"]
  readonly responseTag: ExtensionInteractionAnswerValue["_tag"]
}> {}

export class PiExtensionUiClosedError extends Data.TaggedError("PiExtensionUiClosedError")<{
  readonly message: string
}> {}

export const matchExtensionInteractionResponse = (
  interaction: ExtensionInteractionValue,
  response: ExtensionInteractionAnswerValue,
):
  | {
      readonly _tag: "Accepted"
      readonly value: { readonly value?: string; readonly confirmed?: boolean; readonly cancelled?: true }
    }
  | { readonly _tag: "Rejected" } => {
  if (response._tag === "Cancelled") return { _tag: "Accepted", value: { cancelled: true } }
  if (interaction.method === "confirm") {
    return response._tag === "Confirmation"
      ? { _tag: "Accepted", value: { confirmed: response.confirmed } }
      : { _tag: "Rejected" }
  }
  return response._tag === "Value" ? { _tag: "Accepted", value: { value: response.value } } : { _tag: "Rejected" }
}

type UiResponse = {
  readonly value?: string
  readonly confirmed?: boolean
  readonly cancelled?: true
}

type UiDialogOptions = {
  readonly signal?: AbortSignal
  readonly timeout?: number
}

type PendingUi = {
  readonly interaction: ExtensionInteractionValue
  readonly deferred: Deferred.Deferred<UiResponse>
}

type InteractionInput = ExtensionInteractionValue extends infer Interaction
  ? Interaction extends { readonly interactionId: string }
    ? Omit<Interaction, "interactionId">
    : never
  : never

export const makeExtensionUiRuntime = (
  crypto: {
    readonly randomUUIDv4: Context.Service.Shape<typeof Crypto.Crypto>["randomUUIDv4"]
  },
  publish: (event: typeof SessionScopedEvent.Type) => void,
  theme: unknown,
  customUnavailable: () => unknown,
) =>
  Effect.gen(function* () {
    const runtimeRetention = yield* makeRuntimeRetention
    let projection = ExtensionUiProjection.make({
      revision: 0,
      pendingInteraction: null,
      statuses: [],
      widgets: [],
    })
    let pending: PendingUi | null = null
    const requests = new Map<string, PendingUi>()
    let lifecycle: "Open" | "Closing" | "Closed" = "Open"
    const admissionLock = yield* Semaphore.make(1)
    const interactionLock = yield* Semaphore.make(1)
    const fibers = yield* FiberSet.make()
    const runFork = yield* FiberSet.runtime(fibers)()

    const runPromise = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
      new Promise((resolve, reject) => {
        if (lifecycle !== "Open") {
          reject(new PiExtensionUiClosedError({ message: "Extension UI runtime is closed" }))
          return
        }
        runFork(effect).addObserver(
          Exit.match({
            onFailure: (cause) => reject(Cause.squash(cause)),
            onSuccess: resolve,
          }),
        )
      })

    const runCallback = (effect: Effect.Effect<unknown, unknown>) => {
      if (lifecycle !== "Open") return
      runFork(
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Extension UI callback failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      )
    }

    const commit = (
      update: (current: typeof ExtensionUiProjection.Type) => Omit<typeof ExtensionUiProjection.Type, "revision">,
    ) => {
      if (lifecycle !== "Open") return
      projection = ExtensionUiProjection.make({ ...update(projection), revision: projection.revision + 1 })
      publish(SessionScopedEvent.make({ _tag: "ExtensionUiChanged", projection }))
    }

    const emitNotice = (message: string, notifyType: "info" | "warning" | "error" = "info") =>
      runCallback(
        crypto.randomUUIDv4.pipe(
          Effect.tap((noticeId) =>
            Effect.sync(() =>
              publish(SessionScopedEvent.make({ _tag: "ExtensionNotice", noticeId, message, notifyType })),
            ),
          ),
        ),
      )

    const cancelledResponse = (): UiResponse => ({ cancelled: true })
    const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
      Effect.callback<void>((resume) => {
        if (signal.aborted) {
          resume(Effect.void)
          return
        }
        const onAbort = () => resume(Effect.void)
        signal.addEventListener("abort", onAbort, { once: true })
        return Effect.sync(() => signal.removeEventListener("abort", onAbort))
      })

    const awaitResponse = (
      deferred: Deferred.Deferred<UiResponse>,
      options: UiDialogOptions | undefined,
      includeTimeout: boolean,
    ): Effect.Effect<UiResponse> => {
      let cancellation: Effect.Effect<UiResponse> | null =
        options?.signal === undefined ? null : awaitAbort(options.signal).pipe(Effect.as(cancelledResponse()))
      if (includeTimeout && options?.timeout !== undefined && Number.isFinite(options.timeout)) {
        const timeout = Effect.sleep(Math.max(0, options.timeout)).pipe(Effect.as(cancelledResponse()))
        cancellation = cancellation === null ? timeout : Effect.raceFirst(cancellation, timeout)
      }
      if (cancellation === null) return Deferred.await(deferred)
      return Effect.raceFirst(Deferred.await(deferred), cancellation).pipe(
        Effect.flatMap((response) => Deferred.succeed(deferred, response)),
        Effect.andThen(Deferred.await(deferred)),
      )
    }

    const requestUi = <A>(
      request: InteractionInput,
      select: (response: UiResponse) => A,
      options?: UiDialogOptions,
    ): Promise<A> =>
      runPromise(
        Effect.gen(function* () {
          const queued = yield* admissionLock.withPermits(1)(
            Effect.gen(function* () {
              if (lifecycle !== "Open") {
                return yield* new PiExtensionUiClosedError({ message: "Extension UI runtime is closed" })
              }
              const interactionId = yield* crypto.randomUUIDv4
              const interaction = { interactionId, ...request } as ExtensionInteractionValue
              const deferred = yield* Deferred.make<UiResponse>()
              const admitted = { interaction, deferred }
              requests.set(interactionId, admitted)
              return admitted
            }),
          )
          const interactionId = queued.interaction.interactionId
          const interaction = queued.interaction
          const deferred = queued.deferred
          return yield* Effect.gen(function* () {
            const acquired = yield* Effect.raceFirst(
              interactionLock.take(1).pipe(Effect.as(true)),
              awaitResponse(deferred, options, false).pipe(Effect.as(false)),
            )
            if (!acquired) return select(yield* Deferred.await(deferred))
            yield* Effect.sync(() => {
              pending = queued
              commit((current) => ({ ...current, pendingInteraction: interaction }))
            })
            const response = yield* awaitResponse(deferred, options, true).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (pending?.interaction.interactionId !== interactionId) return
                  pending = null
                  commit((current) => ({ ...current, pendingInteraction: null }))
                }),
              ),
              Effect.ensuring(interactionLock.release(1)),
            )
            return select(response)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                requests.delete(interactionId)
              }),
            ),
          )
        }),
      )

    const uiContext = {
      select: (title: string, options: ReadonlyArray<string>, dialogOptions?: UiDialogOptions) =>
        requestUi({ method: "select", title, options: [...options] }, (response) => response.value, dialogOptions),
      confirm: (title: string, message: string, dialogOptions?: UiDialogOptions) =>
        requestUi({ method: "confirm", title, message }, (response) => response.confirmed === true, dialogOptions),
      input: (title: string, placeholder?: string, dialogOptions?: UiDialogOptions) =>
        requestUi(
          { method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) },
          (response) => response.value,
          dialogOptions,
        ),
      editor: (title: string, prefill?: string) =>
        requestUi(
          { method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
          (response) => response.value,
        ),
      notify: (message: string, notifyType?: "info" | "warning" | "error") => emitNotice(message, notifyType),
      onTerminalInput: () => () => undefined,
      setStatus: (key: string, text?: string) => {
        commit((current) => ({
          ...current,
          statuses: [
            ...current.statuses.filter((item) => item.key !== key),
            ...(text === undefined ? [] : [ExtensionStatusContribution.make({ _tag: "Text", key, text })]),
          ],
        }))
      },
      setStructuredStatus: (key: string, value?: unknown) => {
        if (lifecycle !== "Open") return
        const retention = runtimeRetention.update(key, value)
        if (retention._tag === "RetentionHandled") {
          if (!retention.valid) runCallback(Effect.logWarning("Ignored invalid runtime lease projection", { key }))
          return
        }
        const status = value === undefined ? undefined : extensionStructuredStatusOrUndefined(value)
        if (value !== undefined && status === undefined) {
          runCallback(Effect.logWarning("Ignored non-JSON extension status projection", { key }))
          return
        }
        commit((current) => ({
          ...current,
          statuses: [
            ...current.statuses.filter((item) => item.key !== key),
            ...(status === undefined ? [] : [ExtensionStatusContribution.make({ _tag: "Structured", key, ...status })]),
          ],
        }))
      },
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (
        key: string,
        content?: ReadonlyArray<string>,
        options?: { readonly placement?: "aboveEditor" | "belowEditor" },
      ) => {
        commit((current) => ({
          ...current,
          widgets: [
            ...current.widgets.filter((item) => item.key !== key),
            ...(content === undefined
              ? []
              : [
                  ExtensionWidgetItem.make({
                    key,
                    content: { kind: "text", lines: [...content] },
                    placement: options?.placement ?? "aboveEditor",
                  }),
                ]),
          ],
        }))
      },
      setImageWidget: (
        key: string,
        image?: unknown,
        options?: { readonly placement?: "aboveEditor" | "belowEditor" },
      ) => {
        const content = image === undefined ? undefined : Option.getOrUndefined(decodeExtensionImageWidget(image))
        if (image !== undefined && content === undefined) {
          runCallback(Effect.logWarning("Ignored invalid extension image widget", { key }))
          return
        }
        commit((current) => ({
          ...current,
          widgets: [
            ...current.widgets.filter((item) => item.key !== key),
            ...(content === undefined
              ? []
              : [
                  ExtensionWidgetItem.make({
                    key,
                    content,
                    placement: options?.placement ?? "aboveEditor",
                  }),
                ]),
          ],
        }))
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: () => Promise.reject(customUnavailable()),
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in pi-web" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    }

    const resolveInteraction = (interactionId: string, response: ExtensionInteractionResponseValue) =>
      Effect.gen(function* () {
        const current = pending
        if (current === null || current.interaction.interactionId !== interactionId) {
          return yield* new PiInteractionConflictError({ interactionId })
        }
        const matched = matchExtensionInteractionResponse(current.interaction, response.answer)
        if (matched._tag === "Rejected") {
          return yield* new PiInteractionResponseError({
            interactionId,
            method: current.interaction.method,
            responseTag: response.answer._tag,
          })
        }
        pending = null
        commit((currentProjection) => ({ ...currentProjection, pendingInteraction: null }))
        yield* Deferred.succeed(current.deferred, matched.value)
      })

    const dispose = Effect.gen(function* () {
      const currentRequests = yield* admissionLock.withPermits(1)(
        Effect.sync(() => {
          if (lifecycle !== "Open") return []
          lifecycle = "Closing"
          const admitted = [...requests.values()]
          requests.clear()
          if (pending !== null) {
            pending = null
            projection = ExtensionUiProjection.make({
              ...projection,
              pendingInteraction: null,
              revision: projection.revision + 1,
            })
            publish(SessionScopedEvent.make({ _tag: "ExtensionUiChanged", projection }))
          }
          return admitted
        }),
      )
      yield* Effect.forEach(currentRequests, ({ deferred }) => Deferred.succeed(deferred, cancelledResponse()), {
        discard: true,
      })
      yield* Effect.yieldNow
      yield* FiberSet.clear(fibers)
      lifecycle = "Closed"
    })

    return {
      uiContext,
      projection: () => projection,
      hasRetention: runtimeRetention.hasRetention,
      resolveInteraction,
      dispose,
    }
  })
