import {
  Cause,
  Context,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Layer,
  PubSub,
  Queue,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect"
import {
  RunId,
  RunScopedEvent,
  RunningSessionsEvent,
  RuntimeSnapshot,
  type RuntimeEnvelope as RuntimeEnvelopeValue,
} from "@/api/contract"
import {
  PiAgentAdapter,
  type PiRuntime,
  type PiRuntimeCreateOptions,
  PiPromptBusyError,
  PiPromptIdempotencyError,
} from "./pi-agent-adapter"
import type { PromptInput } from "./prompt-request"
import { hasRuntimeLease } from "@/lib/runtime-lease"

export class RuntimeRegistryError extends Data.TaggedError("RuntimeRegistryError")<{
  readonly operation: string
  readonly message: string
  readonly notFoundId?: string
  readonly conflictOperation?: string
}> {}

export interface RuntimeHandle {
  readonly sessionId: string
  readonly runtime: PiRuntime
  readonly scope: Scope.Closeable
  readonly activity: Queue.Queue<void>
}

export interface ActiveRuntimeSession {
  readonly sessionId: string
  readonly sessionFile: string
  readonly cwd: string
  readonly created: string
  readonly firstMessage: string | null
  readonly isConversationEmpty: boolean
}

type Slot =
  | {
      readonly _tag: "Starting"
      readonly deferred: Deferred.Deferred<RuntimeHandle, RuntimeRegistryError>
    }
  | {
      readonly _tag: "Active"
      readonly handle: RuntimeHandle
    }

interface TableState {
  readonly accepting: boolean
  readonly slots: ReadonlyMap<string, Slot>
}

type StartDecision =
  | { readonly _tag: "Use"; readonly handle: RuntimeHandle }
  | { readonly _tag: "Wait"; readonly deferred: Deferred.Deferred<RuntimeHandle, RuntimeRegistryError> }
  | { readonly _tag: "Start"; readonly starting: Extract<Slot, { readonly _tag: "Starting" }> }
  | { readonly _tag: "Reject"; readonly error: RuntimeRegistryError }

export class SessionRuntimeRegistry extends Context.Service<
  SessionRuntimeRegistry,
  {
    readonly start: (
      requestedId: string,
      options: PiRuntimeCreateOptions,
    ) => Effect.Effect<RuntimeHandle, RuntimeRegistryError>
    readonly active: (sessionId: string) => Effect.Effect<RuntimeHandle, RuntimeRegistryError>
    readonly activeOption: (sessionId: string) => Effect.Effect<RuntimeHandle | null>
    readonly close: (sessionId: string) => Effect.Effect<void>
    readonly nextRunId: Effect.Effect<RunId, RuntimeRegistryError>
    readonly promptRequest: (
      sessionId: string,
      requestId: string,
      input: PromptInput,
    ) => Effect.Effect<
      {
        readonly runId: RunId
        readonly completion: Effect.Effect<
          { readonly runId: RunId; readonly text: string },
          RuntimeRegistryError | PiPromptIdempotencyError
        >
      },
      RuntimeRegistryError | PiPromptIdempotencyError
    >
    readonly compact: (sessionId: string, instructions?: string) => Effect.Effect<RunId, RuntimeRegistryError>
    readonly bash: (
      sessionId: string,
      id: string,
      command: string,
      excludeFromContext: boolean,
    ) => Effect.Effect<RunId, RuntimeRegistryError>
    readonly forkSession: (
      sessionId: string,
      entryId: string,
    ) => Effect.Effect<
      {
        readonly cancelled: boolean
        readonly newSessionId?: string
        readonly newSessionFile?: string
      },
      RuntimeRegistryError
    >
    readonly events: (sessionId: string) => Effect.Effect<Stream.Stream<RuntimeEnvelopeValue>, RuntimeRegistryError>
    readonly activeSessions: Effect.Effect<ReadonlyArray<ActiveRuntimeSession>>
    readonly runningIds: Effect.Effect<ReadonlyArray<string>>
    readonly runningEvents: Stream.Stream<typeof RunningSessionsEvent.Type>
    readonly shutdown: Effect.Effect<void>
  }
>()("pi-web/server/SessionRuntimeRegistry") {}

export interface SessionRuntimeAdapter {
  readonly createRuntime: Context.Service.Shape<typeof PiAgentAdapter>["createRuntime"]
  readonly createFork: Context.Service.Shape<typeof PiAgentAdapter>["createFork"]
}

export interface RunIdGenerator {
  readonly randomUUIDv4: Context.Service.Shape<typeof Crypto.Crypto>["randomUUIDv4"]
}

export const makeSessionRuntimeRegistry = (adapter: SessionRuntimeAdapter, idGenerator: RunIdGenerator) =>
  Effect.gen(function* () {
    const table = yield* SynchronizedRef.make<TableState>({ accepting: true, slots: new Map() })
    const startupFibers = yield* FiberSet.make<void, never>()
    // Changes are invalidations, not an event log. One replayed signal closes the
    // initial-snapshot/subscription race without retaining redundant history.
    const changes = yield* PubSub.sliding<void>({ capacity: 1, replay: 1 })

    const changed = Effect.sync(() => {
      PubSub.publishUnsafe(changes, undefined)
    })

    const removeIf = (sessionId: string, expected: Slot) =>
      SynchronizedRef.update(table, (current) => {
        if (current.slots.get(sessionId) !== expected) return current
        const next = new Map(current.slots)
        next.delete(sessionId)
        return { ...current, slots: next }
      }).pipe(Effect.andThen(changed))

    const closeHandle = (handle: RuntimeHandle) => Scope.close(handle.scope, Exit.succeed(undefined))

    const activeOption = (sessionId: string) =>
      SynchronizedRef.get(table).pipe(
        Effect.map((current) => {
          const slot = current.slots.get(sessionId)
          return slot?._tag === "Active" ? slot.handle : null
        }),
      )

    const active = (sessionId: string) =>
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(table)
        const slot = current.slots.get(sessionId)
        if (slot?._tag === "Active") return slot.handle
        if (slot?._tag === "Starting") return yield* Deferred.await(slot.deferred)
        return yield* new RuntimeRegistryError({
          operation: "runtime.active",
          message: "Session runtime is not active",
          notFoundId: sessionId,
        })
      })

    const close = (sessionId: string) =>
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(table)
        const slot = current.slots.get(sessionId)
        if (slot?._tag === "Starting") {
          const handle = yield* Deferred.await(slot.deferred).pipe(Effect.option)
          if (handle._tag === "Some") yield* closeHandle(handle.value)
          return
        }
        if (slot?._tag === "Active") yield* closeHandle(slot.handle)
      })

    const idleLoop = (handle: RuntimeHandle): Effect.Effect<void> =>
      Effect.suspend(() =>
        Effect.raceFirst(
          Queue.take(handle.activity).pipe(Effect.as(false)),
          Effect.sleep("10 minutes").pipe(Effect.as(true)),
        ).pipe(
          Effect.flatMap((expired) =>
            expired
              ? handle.runtime.snapshot.pipe(
                  Effect.matchEffect({
                    onFailure: () => closeHandle(handle),
                    onSuccess: (snapshot) =>
                      hasRuntimeLease([...snapshot.extensionUi.textStatuses, ...snapshot.extensionUi.companionStatuses])
                        ? idleLoop(handle)
                        : closeHandle(handle),
                  }),
                )
              : idleLoop(handle),
          ),
        ),
      )

    const installHandle = (
      requestedId: string,
      starting: Extract<Slot, { readonly _tag: "Starting" }>,
      runtime: PiRuntime,
      scope: Scope.Closeable,
    ) =>
      Effect.gen(function* () {
        const activity = yield* Queue.sliding<void>(1)
        const handle: RuntimeHandle = {
          sessionId: runtime.sessionId,
          runtime,
          scope,
          activity,
        }
        const activeSlot: Slot = { _tag: "Active", handle }

        yield* Scope.addFinalizer(scope, runtime.dispose)
        yield* Scope.addFinalizer(scope, Queue.shutdown(activity))
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            yield* SynchronizedRef.update(table, (current) => {
              const next = new Map(current.slots)
              if (next.get(requestedId) === starting) next.delete(requestedId)
              if (next.get(runtime.sessionId) === activeSlot) next.delete(runtime.sessionId)
              return { ...current, slots: next }
            })
            yield* changed
          }),
        )

        const installed = yield* SynchronizedRef.modify(table, (current) => {
          if (!current.accepting || current.slots.get(requestedId) !== starting) return [false, current] as const
          const next = new Map(current.slots)
          next.delete(requestedId)
          next.set(runtime.sessionId, activeSlot)
          return [true, { ...current, slots: next }] as const
        })
        if (!installed) {
          const error = new RuntimeRegistryError({
            operation: "runtime.start",
            message: "Runtime registry is shutting down",
          })
          yield* Scope.close(scope, Exit.fail(error))
          yield* Deferred.fail(starting.deferred, error)
          return yield* error
        }
        yield* changed
        yield* Deferred.succeed(starting.deferred, handle)
        Queue.offerUnsafe(activity, undefined)

        yield* Stream.fromPubSub(runtime.events).pipe(
          Stream.runForEach(() =>
            Effect.sync(() => {
              Queue.offerUnsafe(activity, undefined)
              PubSub.publishUnsafe(changes, undefined)
            }),
          ),
          Effect.forkIn(scope),
        )
        yield* idleLoop(handle).pipe(Effect.forkIn(scope))
        return handle
      })

    const start = (requestedId: string, options: PiRuntimeCreateOptions) =>
      Effect.gen(function* () {
        const decision = yield* SynchronizedRef.modifyEffect(
          table,
          (current): Effect.Effect<readonly [StartDecision, TableState]> =>
            Effect.gen(function* () {
              if (!current.accepting) {
                const error = new RuntimeRegistryError({
                  operation: "runtime.start",
                  message: "Runtime registry is shut down",
                })
                return [{ _tag: "Reject", error } satisfies StartDecision, current] as const
              }
              const existing = current.slots.get(requestedId)
              if (existing?._tag === "Active") {
                return [{ _tag: "Use", handle: existing.handle } satisfies StartDecision, current] as const
              }
              if (existing?._tag === "Starting") {
                return [{ _tag: "Wait", deferred: existing.deferred } satisfies StartDecision, current] as const
              }
              const deferred = yield* Deferred.make<RuntimeHandle, RuntimeRegistryError>()
              const starting = { _tag: "Starting" as const, deferred }
              const next = new Map(current.slots)
              next.set(requestedId, starting)
              return [{ _tag: "Start", starting } satisfies StartDecision, { ...current, slots: next }] as const
            }),
        )

        if (decision._tag === "Use") {
          Queue.offerUnsafe(decision.handle.activity, undefined)
          return decision.handle
        }
        if (decision._tag === "Wait") return yield* Deferred.await(decision.deferred)
        if (decision._tag === "Reject") return yield* decision.error

        const scope = yield* Scope.make("sequential")
        const startup = adapter.createRuntime(options).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((cause) => new RuntimeRegistryError({ operation: "runtime.start", message: cause.message })),
          Effect.flatMap((runtime) => installHandle(requestedId, decision.starting, runtime, scope)),
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              Effect.gen(function* () {
                const failure = Cause.squash(cause)
                const error =
                  failure instanceof RuntimeRegistryError
                    ? failure
                    : new RuntimeRegistryError({
                        operation: "runtime.start",
                        message: "Runtime startup was interrupted",
                      })
                yield* Scope.close(scope, Exit.fail(error))
                yield* removeIf(requestedId, decision.starting)
                yield* Deferred.fail(decision.starting.deferred, error)
              }),
            onSuccess: () => Effect.void,
          }),
        )
        yield* FiberSet.run(startupFibers, startup)
        return yield* Deferred.await(decision.starting.deferred)
      })

    const nextRunId = idGenerator.randomUUIDv4.pipe(
      Effect.map((value) => RunId.make(value)),
      Effect.mapError((cause) => new RuntimeRegistryError({ operation: "runtime.runId", message: String(cause) })),
    )

    const isBusy = (snapshot: typeof RuntimeSnapshot.Type) =>
      snapshot.isStreaming || snapshot.isPromptRunning || snapshot.isCompacting || snapshot.isBashRunning

    const promptError = (cause: { readonly message: string }) =>
      cause instanceof PiPromptIdempotencyError
        ? cause
        : new RuntimeRegistryError({
            operation: "runtime.promptRequest",
            message: cause.message,
            ...(cause instanceof PiPromptBusyError ? { conflictOperation: "prompt" } : {}),
          })

    const promptRequest = (sessionId: string, requestId: string, input: PromptInput) =>
      Effect.gen(function* () {
        const handle = yield* active(sessionId)
        const runId = yield* nextRunId
        Queue.offerUnsafe(handle.activity, undefined)
        const request = yield* handle.runtime.promptRequest(runId, requestId, input).pipe(Effect.mapError(promptError))
        const completion = request.completion.pipe(Effect.mapError(promptError))
        yield* completion.pipe(Effect.ensuring(changed), Effect.ignore, Effect.forkIn(handle.scope))
        return {
          runId: request.runId,
          completion,
        }
      })

    const compact = (sessionId: string, instructions?: string) =>
      Effect.gen(function* () {
        const handle = yield* active(sessionId)
        const snapshot = yield* handle.runtime.snapshot.pipe(
          Effect.mapError(
            (cause) => new RuntimeRegistryError({ operation: "runtime.snapshot", message: cause.message }),
          ),
        )
        if (isBusy(snapshot)) {
          return yield* new RuntimeRegistryError({
            operation: "runtime.compact",
            message: "Session already has an active operation",
            conflictOperation: "compact",
          })
        }
        const runId = yield* nextRunId
        Queue.offerUnsafe(handle.activity, undefined)
        yield* handle.runtime.compact(runId, instructions).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              handle.runtime.publishRunEvent(
                RunScopedEvent.make({
                  _tag: "CompactionFinished",
                  runId,
                  aborted: false,
                  errorMessage: "Compaction failed",
                }),
              )
            }),
          ),
          Effect.ensuring(changed),
          Effect.ignore,
          Effect.forkIn(handle.scope),
        )
        return runId
      })

    const bash = (sessionId: string, id: string, command: string, excludeFromContext: boolean) =>
      Effect.gen(function* () {
        const handle = yield* active(sessionId)
        const snapshot = yield* handle.runtime.snapshot.pipe(
          Effect.mapError(
            (cause) => new RuntimeRegistryError({ operation: "runtime.snapshot", message: cause.message }),
          ),
        )
        if (isBusy(snapshot)) {
          return yield* new RuntimeRegistryError({
            operation: "runtime.bash",
            message: "Session already has an active operation",
            conflictOperation: "bash",
          })
        }
        const runId = yield* nextRunId
        Queue.offerUnsafe(handle.activity, undefined)
        yield* handle.runtime.executeBash(runId, id, command, excludeFromContext).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              handle.runtime.publishRunEvent(
                RunScopedEvent.make({
                  _tag: "BashFailed",
                  runId,
                  id,
                  message: "Shell command failed",
                }),
              )
            }),
          ),
          Effect.ensuring(changed),
          Effect.ignore,
          Effect.forkIn(handle.scope),
        )
        return runId
      })

    const forkSession = (sessionId: string, entryId: string) =>
      Effect.gen(function* () {
        const handle = yield* active(sessionId)
        const result = yield* adapter
          .createFork(handle.runtime.sessionFile, entryId)
          .pipe(
            Effect.mapError((cause) => new RuntimeRegistryError({ operation: "runtime.fork", message: cause.message })),
          )
        if (!result.cancelled) yield* closeHandle(handle)
        return result
      })

    const events = (sessionId: string) =>
      Effect.map(active(sessionId), (handle) => Stream.fromPubSub(handle.runtime.events))

    const activeSessions = Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(table)
      const handles = [...current.slots.values()].flatMap((slot) => (slot._tag === "Active" ? [slot.handle] : []))
      return yield* Effect.forEach(
        handles,
        (handle) =>
          Effect.all({
            firstMessage: handle.runtime.firstMessage,
            isConversationEmpty: handle.runtime.isConversationEmpty,
          }).pipe(
            Effect.map(
              ({ firstMessage, isConversationEmpty }) =>
                ({
                  sessionId: handle.sessionId,
                  sessionFile: handle.runtime.sessionFile,
                  cwd: handle.runtime.cwd,
                  created: handle.runtime.created,
                  firstMessage,
                  isConversationEmpty,
                }) satisfies ActiveRuntimeSession,
            ),
          ),
        { concurrency: "unbounded" },
      )
    })

    const runningIds = Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(table)
      const handles = [...current.slots.values()].flatMap((slot) => (slot._tag === "Active" ? [slot.handle] : []))
      const states = yield* Effect.forEach(
        handles,
        (handle) =>
          handle.runtime.snapshot.pipe(
            Effect.map((snapshot) => ({ handle, snapshot })),
            Effect.option,
          ),
        { concurrency: "unbounded" },
      )
      return states.flatMap((state) =>
        state._tag === "Some" &&
        (state.value.snapshot.isStreaming ||
          state.value.snapshot.isPromptRunning ||
          state.value.snapshot.isCompacting ||
          state.value.snapshot.isBashRunning)
          ? [state.value.handle.sessionId]
          : [],
      )
    })

    const runningEvents = Stream.concat(
      Stream.fromEffect(runningIds),
      Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => runningIds)),
    ).pipe(
      Stream.changesWith(
        (left, right) =>
          left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]),
      ),
      Stream.map((sessionIds) => RunningSessionsEvent.make({ sessionIds })),
    )

    const shutdown = Effect.gen(function* () {
      const current = yield* SynchronizedRef.modify(
        table,
        (state) =>
          [
            state,
            {
              accepting: false,
              slots: new Map(),
            },
          ] as const,
      )
      const handles = [...current.slots.values()].flatMap((slot) => (slot._tag === "Active" ? [slot.handle] : []))
      const starting = [...current.slots.values()].flatMap((slot) => (slot._tag === "Starting" ? [slot] : []))
      const shutdownError = new RuntimeRegistryError({
        operation: "runtime.shutdown",
        message: "Runtime registry shut down",
      })
      yield* Effect.forEach(starting, (slot) => Deferred.fail(slot.deferred, shutdownError), {
        concurrency: "unbounded",
        discard: true,
      })
      yield* FiberSet.clear(startupFibers)
      yield* Effect.forEach(handles, closeHandle, { concurrency: "unbounded", discard: true })
      yield* PubSub.shutdown(changes)
    })

    yield* Effect.addFinalizer(() => shutdown)

    return SessionRuntimeRegistry.of({
      start,
      active,
      activeOption,
      close,
      nextRunId,
      promptRequest,
      compact,
      bash,
      forkSession,
      events,
      activeSessions,
      runningIds,
      runningEvents,
      shutdown,
    })
  })

const layerEffect = Effect.gen(function* () {
  const adapter = yield* PiAgentAdapter
  const crypto = yield* Crypto.Crypto
  return yield* makeSessionRuntimeRegistry(adapter, crypto)
})

export const SessionRuntimeRegistryLive: Layer.Layer<SessionRuntimeRegistry, never, Crypto.Crypto | PiAgentAdapter> =
  Layer.effect(SessionRuntimeRegistry, layerEffect)
