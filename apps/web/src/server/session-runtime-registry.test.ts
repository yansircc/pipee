import { it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, PubSub, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vite-plus/test"
import { RunId, RuntimeEvent, RuntimeSnapshot } from "@/api/contract"
import { PiAdapterError, type PiRuntime } from "./pi-agent-adapter"
import { makeSessionRuntimeRegistry, type SessionRuntimeAdapter } from "./session-runtime-registry"

const runtimeSnapshot = (sessionId: string, sessionFile: string) =>
  RuntimeSnapshot.make({
    runId: null,
    sessionId,
    sessionFile,
    isStreaming: false,
    isPromptRunning: false,
    isCompacting: false,
    isBashRunning: false,
    activeBashExecution: null,
    completedBashExecution: null,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    pendingMessageCount: 0,
    queuedMessages: { steering: [], followUp: [] },
    contextUsage: null,
    systemPrompt: "",
    thinkingLevel: "off",
    extensionStatuses: [],
    extensionWidgets: [],
  })

const makeRuntime = (
  sessionId: string,
  disposeCount: Ref.Ref<number>,
  promptEffect: Effect.Effect<void, PiAdapterError> = Effect.void,
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.sliding<RuntimeEvent>({ capacity: 256, replay: 64 })
    const firstMessage = yield* Ref.make<string | null>(null)
    const sessionFile = `/sessions/${sessionId}.jsonl`
    const runtime: PiRuntime = {
      sessionId,
      sessionFile,
      cwd: "/repo",
      created: "2026-07-15T00:00:00.000Z",
      firstMessage: Ref.get(firstMessage),
      isConversationEmpty: Ref.get(firstMessage).pipe(Effect.map((message) => message === null)),
      events,
      snapshot: Effect.succeed(runtimeSnapshot(sessionId, sessionFile)),
      promptRequest: (runId, _requestId, input) =>
        Ref.update(firstMessage, (current) => current ?? (input.message.trim() || null)).pipe(
          Effect.as({
            runId,
            completion: promptEffect.pipe(Effect.as({ runId, text: "OK" })),
          }),
        ),
      steer: () => Effect.void,
      followUp: () => Effect.void,
      abort: Effect.void,
      executeBash: () => Effect.die("unused executeBash"),
      abortBash: Effect.void,
      setModel: (provider, id) => Effect.succeed({ provider, id }),
      navigate: () => Effect.succeed({ cancelled: false }),
      setThinkingLevel: () => Effect.void,
      compact: () => Effect.succeed({}),
      abortCompaction: Effect.void,
      setSessionName: () => Effect.void,
      stats: Effect.die("unused stats"),
      lastAssistantText: Effect.succeed("OK"),
      setAutoCompaction: () => Effect.void,
      setAutoRetry: () => Effect.void,
      clearQueue: Effect.succeed({ steering: [], followUp: [] }),
      tools: Effect.succeed([]),
      commands: Effect.succeed([]),
      setTools: () => Effect.void,
      invokeExtensionCommand: () => Effect.succeed({ tools: [], extensionStatuses: [] }),
      resolveExtensionUi: () => Effect.void,
      sendExtensionUiInput: () => Effect.void,
      reload: Effect.void,
      dispose: Ref.update(disposeCount, (count) => count + 1).pipe(Effect.andThen(PubSub.shutdown(events))),
    }
    return runtime
  })

const runIds = {
  randomUUIDv4: Effect.succeed("00000000-0000-4000-8000-000000000001"),
}

it.effect("shares one runtime across concurrent starts", () =>
  Effect.gen(function* () {
    const createCount = yield* Ref.make(0)
    const disposeCount = yield* Ref.make(0)
    const gate = yield* Deferred.make<void>()
    const runtime = yield* makeRuntime("session-1", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () =>
        Ref.update(createCount, (count) => count + 1).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(runtime)),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    const first = yield* registry
      .start("session-1", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
      .pipe(Effect.forkChild)
    const second = yield* registry
      .start("session-1", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
      .pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(yield* Ref.get(createCount)).toBe(1)
    yield* Deferred.succeed(gate, undefined)
    const [left, right] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    expect(left).toBe(right)
  }),
)

it.effect("clears failed Starting state and allows retry", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-2", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () =>
        Ref.getAndUpdate(attempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Effect.fail(new PiAdapterError({ operation: "create", message: "first failure" }))
              : Effect.succeed(runtime),
          ),
        ),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    const first = yield* Effect.exit(
      registry.start("session-2", { sessionFile: runtime.sessionFile, cwd: runtime.cwd }),
    )
    expect(Exit.isFailure(first)).toBe(true)
    expect((yield* registry.start("session-2", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })).runtime).toBe(
      runtime,
    )
    expect(yield* Ref.get(attempts)).toBe(2)
  }),
)

it.effect("projects active sessions before persistence", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-transient", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)

    yield* registry.start("new:request-1", { sessionFile: null, cwd: runtime.cwd })

    expect(yield* registry.activeSessions).toEqual([
      {
        sessionId: "session-transient",
        sessionFile: "/sessions/session-transient.jsonl",
        cwd: "/repo",
        created: "2026-07-15T00:00:00.000Z",
        firstMessage: null,
        isConversationEmpty: true,
      },
    ])
  }),
)

it.effect("projects the accepted first prompt before the run finishes", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const release = yield* Deferred.make<void>()
    const runtime = yield* makeRuntime("session-title", disposeCount, Deferred.await(release))
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("new:request-title", { sessionFile: null, cwd: runtime.cwd })

    yield* registry.promptRequest("session-title", "request-title", { message: "find the release date" })

    expect(yield* registry.activeSessions).toEqual([
      expect.objectContaining({ sessionId: "session-title", firstMessage: "find the release date" }),
    ])
    yield* registry.close("session-title")
  }),
)

it.effect("returns prompt request identity before its completion", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const completion = yield* Deferred.make<string>()
    const base = yield* makeRuntime("session-progress", disposeCount)
    const runtime: PiRuntime = {
      ...base,
      promptRequest: (runId) =>
        Effect.succeed({
          runId,
          completion: Deferred.await(completion).pipe(Effect.map((text) => ({ runId, text }))),
        }),
    }
    const registry = yield* makeSessionRuntimeRegistry(
      {
        createRuntime: () => Effect.succeed(runtime),
        createFork: () => Effect.succeed({ cancelled: true }),
      },
      runIds,
    )
    yield* registry.start(runtime.sessionId, { sessionFile: runtime.sessionFile, cwd: runtime.cwd })

    const request = yield* registry.promptRequest(runtime.sessionId, "message-42", {
      message: "hello",
    })
    expect(request.runId).toBe("00000000-0000-4000-8000-000000000001")
    yield* Deferred.succeed(completion, "done")
    expect(yield* request.completion).toEqual({ runId: request.runId, text: "done" })
  }),
)

it.effect("invalidates running sessions after prompt finalizers clear busy state", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const busy = yield* Ref.make(false)
    const release = yield* Deferred.make<void>()
    const busyObserved = yield* Deferred.make<void>()
    const idleObserved = yield* Deferred.make<void>()
    const observedBusy = yield* Ref.make(false)
    const base = yield* makeRuntime("session-running", disposeCount)
    const runtime: PiRuntime = {
      ...base,
      snapshot: Ref.get(busy).pipe(
        Effect.map((isPromptRunning) => ({
          ...runtimeSnapshot(base.sessionId, base.sessionFile),
          isPromptRunning,
        })),
      ),
      promptRequest: (runId) =>
        Ref.set(busy, true).pipe(
          Effect.andThen(PubSub.publish(base.events, RuntimeEvent.make({ _tag: "RunStarted", runId }))),
          Effect.as({
            runId,
            completion: Deferred.await(release).pipe(
              Effect.andThen(PubSub.publish(base.events, RuntimeEvent.make({ _tag: "RunFinished", runId }))),
              Effect.as({ runId, text: "done" }),
              Effect.ensuring(Ref.set(busy, false)),
            ),
          }),
        ),
    }
    const registry = yield* makeSessionRuntimeRegistry(
      {
        createRuntime: () => Effect.succeed(runtime),
        createFork: () => Effect.succeed({ cancelled: true }),
      },
      runIds,
    )
    yield* registry.start(runtime.sessionId, { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    const observer = yield* registry.runningEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.sessionIds.includes(runtime.sessionId)) {
            yield* Ref.set(observedBusy, true)
            yield* Deferred.succeed(busyObserved, undefined)
          } else if (yield* Ref.get(observedBusy)) {
            yield* Deferred.succeed(idleObserved, undefined)
          }
        }),
      ),
      Effect.forkChild,
    )
    yield* Effect.yieldNow

    const request = yield* registry.promptRequest(runtime.sessionId, "message-running", { message: "hello" })
    yield* Deferred.await(busyObserved)
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(idleObserved)

    expect(yield* registry.runningIds).toEqual([])
    expect(yield* request.completion).toEqual({ runId: request.runId, text: "done" })
    yield* Fiber.interrupt(observer)
  }),
)

it.effect("keeps startup owned by the registry when the first waiter is interrupted", () =>
  Effect.gen(function* () {
    const createCount = yield* Ref.make(0)
    const disposeCount = yield* Ref.make(0)
    const gate = yield* Deferred.make<void>()
    const runtime = yield* makeRuntime("session-owned-start", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () =>
        Ref.update(createCount, (count) => count + 1).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(runtime)),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    const first = yield* registry
      .start("session-owned-start", {
        sessionFile: runtime.sessionFile,
        cwd: runtime.cwd,
      })
      .pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(first)
    const second = yield* registry
      .start("session-owned-start", {
        sessionFile: runtime.sessionFile,
        cwd: runtime.cwd,
      })
      .pipe(Effect.forkChild)
    yield* Deferred.succeed(gate, undefined)
    expect((yield* Fiber.join(second)).runtime).toBe(runtime)
    expect(yield* Ref.get(createCount)).toBe(1)
  }),
)

it.effect("interrupts Starting work and prevents resurrection after shutdown", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const gate = yield* Deferred.make<void>()
    const started = yield* Deferred.make<void>()
    const runtime = yield* makeRuntime("session-shutdown-start", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(runtime)),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    const waiter = yield* registry
      .start("session-shutdown-start", {
        sessionFile: runtime.sessionFile,
        cwd: runtime.cwd,
      })
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* registry.shutdown
    const exit = yield* Fiber.await(waiter)
    expect(Exit.isFailure(exit)).toBe(true)
    yield* Deferred.succeed(gate, undefined)
    yield* Effect.yieldNow
    expect(yield* registry.activeOption("session-shutdown-start")).toBeNull()
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          registry.start("session-after-shutdown", {
            sessionFile: "/sessions/after.jsonl",
            cwd: "/repo",
          }),
        ),
      ),
    ).toBe(true)
  }),
)

it.effect("closes the old handle after a successful fork", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-3", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () =>
        Effect.succeed({ cancelled: false, newSessionId: "forked", newSessionFile: "/sessions/forked.jsonl" }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("session-3", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    yield* registry.forkSession("session-3", "entry-1")
    expect(yield* Ref.get(disposeCount)).toBe(1)
    expect(yield* registry.activeOption("session-3")).toBeNull()
  }),
)

it.effect("expires idle runtime scopes with TestClock", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-4", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("session-4", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    yield* Effect.yieldNow
    yield* TestClock.adjust("10 minutes")
    expect(yield* registry.activeOption("session-4")).toBeNull()
    expect(yield* Ref.get(disposeCount)).toBe(1)
  }),
)

it.effect("keeps a runtime alive while an extension owns a runtime lease", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const base = yield* makeRuntime("session-leased", disposeCount)
    const leased: PiRuntime = {
      ...base,
      snapshot: Effect.succeed({
        ...runtimeSnapshot(base.sessionId, base.sessionFile),
        extensionStatuses: [
          {
            key: "pi-loop/runtime-lease",
            status: {
              kind: "pi/runtime-lease",
              version: 1,
              owner: "pi-loop",
              reason: "automation-present",
            },
          },
        ],
      }),
    }
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(leased),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start(leased.sessionId, { sessionFile: leased.sessionFile, cwd: leased.cwd })
    yield* Effect.yieldNow
    yield* TestClock.adjust("20 minutes")
    expect(yield* registry.activeOption(leased.sessionId)).not.toBeNull()
    expect(yield* Ref.get(disposeCount)).toBe(0)
    yield* registry.close(leased.sessionId)
  }),
)

it.effect("closes an idle runtime when lease inspection fails", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const base = yield* makeRuntime("session-lease-failure", disposeCount)
    const runtime: PiRuntime = {
      ...base,
      snapshot: Effect.fail(new PiAdapterError({ operation: "runtime.snapshot", message: "unavailable" })),
    }
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start(runtime.sessionId, { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    yield* Effect.yieldNow
    yield* TestClock.adjust("10 minutes")
    expect(yield* registry.activeOption(runtime.sessionId)).toBeNull()
    expect(yield* Ref.get(disposeCount)).toBe(1)
  }),
)

it.effect("returns bash run identity before completion and redacts background failures", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const base = yield* makeRuntime("session-bash", disposeCount)
    const release = yield* Deferred.make<void>()
    const runtime: PiRuntime = {
      ...base,
      executeBash: (_runId, _id, _command, _excludeFromContext) =>
        Deferred.await(release).pipe(
          Effect.andThen(
            Effect.fail(
              new PiAdapterError({
                operation: "runtime.bash",
                message: "secret-key-in-provider-error",
              }),
            ),
          ),
        ),
    }
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("session-bash", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    const stream = yield* registry.events("session-bash")
    const runId = yield* registry.bash("session-bash", "bash-1", "printf secret", false)
    expect(runId).toBe("00000000-0000-4000-8000-000000000001")
    yield* Deferred.succeed(release, undefined)
    const event = yield* Stream.runHead(stream)
    expect(event._tag).toBe("Some")
    if (event._tag === "Some") {
      expect(event.value).toMatchObject({
        _tag: "BashFailed",
        runId,
        id: "bash-1",
        message: "Shell command failed",
      })
      expect(JSON.stringify(event.value)).not.toContain("secret-key-in-provider-error")
    }
  }),
)

it.effect("replays pre-SSE events and releases disconnected subscriptions", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-6", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("session-6", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    yield* PubSub.publish(
      runtime.events,
      RuntimeEvent.make({
        _tag: "RunStarted",
        runId: RunId.make("run-before-sse"),
      }),
    )

    const stream = yield* registry.events("session-6")
    const first = yield* Stream.runHead(stream)
    expect(first._tag).toBe("Some")
    if (first._tag === "Some") expect(first.value.runId).toBe("run-before-sse")

    yield* Effect.yieldNow
    const baseline = runtime.events.subscribers.size
    expect(baseline).toBe(1)
    const subscriber = yield* Stream.runDrain(stream).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    expect(runtime.events.subscribers.size).toBe(baseline + 1)
    yield* Fiber.interrupt(subscriber)
    yield* Effect.yieldNow
    expect(runtime.events.subscribers.size).toBe(baseline)
  }),
)

it.effect("closes every active handle on registry shutdown", () =>
  Effect.gen(function* () {
    const disposeCount = yield* Ref.make(0)
    const runtime = yield* makeRuntime("session-7", disposeCount)
    const adapter: SessionRuntimeAdapter = {
      createRuntime: () => Effect.succeed(runtime),
      createFork: () => Effect.succeed({ cancelled: true }),
    }
    const registry = yield* makeSessionRuntimeRegistry(adapter, runIds)
    yield* registry.start("session-7", { sessionFile: runtime.sessionFile, cwd: runtime.cwd })
    yield* registry.shutdown
    expect(yield* Ref.get(disposeCount)).toBe(1)
    expect(yield* registry.activeOption("session-7")).toBeNull()
  }),
)
