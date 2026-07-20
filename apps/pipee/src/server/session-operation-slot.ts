import { Data, Effect, SynchronizedRef } from "effect"
import { OperationSlot } from "@/api/contract"

export type OperationKind = Exclude<typeof OperationSlot.Type, { readonly _tag: "Idle" }>["kind"]

export class PiOperationBusyError extends Data.TaggedError("PiOperationBusyError")<{
  readonly kind: OperationKind
  readonly message: string
}> {}

export interface SessionOperationSlot {
  readonly snapshot: Effect.Effect<typeof OperationSlot.Type>
  readonly begin: (kind: OperationKind, operationId: string) => Effect.Effect<void, PiOperationBusyError>
  readonly activate: (kind: OperationKind, operationId: string) => Effect.Effect<void>
  readonly release: (kind: OperationKind, operationId: string) => Effect.Effect<void>
  readonly run: <A, E, R>(
    kind: OperationKind,
    operationId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PiOperationBusyError, R>
}

const owns = (slot: typeof OperationSlot.Type, kind: OperationKind, operationId: string): boolean =>
  slot._tag !== "Idle" && slot.kind === kind && slot.operationId === operationId

export const makeSessionOperationSlot = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<typeof OperationSlot.Type>(OperationSlot.make({ _tag: "Idle" }))

  const begin = (kind: OperationKind, operationId: string) =>
    SynchronizedRef.modifyEffect(state, (current) =>
      current._tag === "Idle"
        ? Effect.succeed([undefined, OperationSlot.make({ _tag: "Starting", kind, operationId })] as const)
        : Effect.fail(
            new PiOperationBusyError({
              kind: current.kind,
              message: `Session operation ${current.kind} is already active`,
            }),
          ),
    )

  const activate = (kind: OperationKind, operationId: string) =>
    SynchronizedRef.update(state, (current) =>
      owns(current, kind, operationId) ? OperationSlot.make({ _tag: "Active", kind, operationId }) : current,
    )

  const release = (kind: OperationKind, operationId: string) =>
    SynchronizedRef.update(state, (current) =>
      owns(current, kind, operationId) ? OperationSlot.make({ _tag: "Idle" }) : current,
    )

  const run: SessionOperationSlot["run"] = (kind, operationId, effect) =>
    Effect.acquireUseRelease(
      begin(kind, operationId).pipe(Effect.andThen(activate(kind, operationId))),
      () => effect,
      () => release(kind, operationId),
    )

  return {
    snapshot: SynchronizedRef.get(state),
    begin,
    activate,
    release,
    run,
  } satisfies SessionOperationSlot
})
