import { Clock, Effect, FileSystem, Path, Random, Schema, Semaphore } from "effect";
import { StateStoreError } from "./errors.ts";
import type { IlinkImage } from "./ilink-protocol.ts";
import { messageBatchIdentity } from "./message.ts";
import {
  BridgeStateJsonSchema,
  type BridgeState,
  type PendingImageBatch,
  type SessionBinding,
  type WeixinAuth,
} from "./schema.ts";

export type InboundStateEvent =
  | {
      readonly _tag: "CollectImages";
      readonly sessionId: string;
      readonly userId: string;
      readonly messageId: string;
      readonly images: ReadonlyArray<IlinkImage>;
      readonly contextToken: string;
      readonly deadlineAt: number;
    }
  | {
      readonly _tag: "DispatchImages";
      readonly sessionId: string;
      readonly userId: string;
      readonly messageId: string;
      readonly images: ReadonlyArray<IlinkImage>;
      readonly contextToken: string;
      readonly prompt: string;
    }
  | { readonly _tag: "FlushImages" }
  | { readonly _tag: "ExpireImages"; readonly now: number }
  | { readonly _tag: "CompleteImages"; readonly requestId: string };

const EMPTY_STATE: BridgeState = {
  version: 2,
  enabled: false,
  cursor: "",
  processedMessageIds: [],
};

export interface StateStore {
  readonly path: string;
  readonly read: Effect.Effect<BridgeState, StateStoreError>;
  readonly write: (state: BridgeState) => Effect.Effect<void, StateStoreError>;
  readonly saveAuth: (auth: WeixinAuth) => Effect.Effect<BridgeState, StateStoreError>;
  readonly clearAuth: Effect.Effect<BridgeState, StateStoreError>;
  readonly bind: (binding: SessionBinding) => Effect.Effect<BridgeState, StateStoreError>;
  readonly setEnabled: (enabled: boolean) => Effect.Effect<BridgeState, StateStoreError>;
  readonly markProcessed: (messageId: string) => Effect.Effect<BridgeState, StateStoreError>;
  readonly saveCursor: (cursor: string) => Effect.Effect<BridgeState, StateStoreError>;
  readonly transitionInbound: (
    event: InboundStateEvent,
  ) => Effect.Effect<BridgeState, StateStoreError>;
  readonly logout: Effect.Effect<BridgeState, StateStoreError>;
}

const stateError = (operation: StateStoreError["operation"], path: string) => (cause: unknown) =>
  new StateStoreError({ operation, path, cause });

export const makeStateStore = (
  statePath: string,
  processedLimit = 512,
): Effect.Effect<StateStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const lock = yield* Semaphore.make(1);
    const directory = path.dirname(statePath);

    const writeUnlocked = (state: BridgeState): Effect.Effect<void, StateStoreError> =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeUnknownEffect(BridgeStateJsonSchema)(state).pipe(
          Effect.mapError(stateError("encode", statePath)),
        );
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(stateError("write", statePath)));
        yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(stateError("write", statePath)));
        const timestamp = yield* Clock.currentTimeMillis;
        const nonce = yield* Random.nextInt;
        const temporary = path.join(directory, `.state-${timestamp}-${nonce}.tmp`);
        const replace = Effect.gen(function* () {
          yield* fs.writeFileString(temporary, `${encoded}\n`, { flag: "wx", mode: 0o600 });
          yield* fs.chmod(temporary, 0o600);
          yield* fs.rename(temporary, statePath);
          yield* fs.chmod(statePath, 0o600);
        }).pipe(Effect.mapError(stateError("write", statePath)));
        yield* replace.pipe(
          Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
        );
      });

    const readUnlocked: StateStore["read"] = Effect.gen(function* () {
      const exists = yield* fs
        .exists(statePath)
        .pipe(Effect.mapError(stateError("read", statePath)));
      if (!exists) return EMPTY_STATE;
      const encoded = yield* fs
        .readFileString(statePath)
        .pipe(Effect.mapError(stateError("read", statePath)));
      return yield* Schema.decodeUnknownEffect(BridgeStateJsonSchema)(encoded).pipe(
        Effect.mapError(stateError("decode", statePath)),
      );
    });

    const read: StateStore["read"] = lock
      .withPermits(1)(readUnlocked)
      .pipe(Effect.withSpan("pi_weixin.state.read"));

    const write = (state: BridgeState) =>
      lock.withPermits(1)(writeUnlocked(state)).pipe(Effect.withSpan("pi_weixin.state.write"));
    const update = (change: (state: BridgeState) => BridgeState) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = change(yield* readUnlocked);
          yield* writeUnlocked(next);
          return next;
        }),
      );

    const withProcessed = (state: BridgeState, messageId: string): BridgeState =>
      state.processedMessageIds.includes(messageId)
        ? state
        : {
            ...state,
            processedMessageIds: [...state.processedMessageIds, messageId].slice(-processedLimit),
          };

    const appendBatch = (
      batch: PendingImageBatch | undefined,
      event: Extract<InboundStateEvent, { readonly _tag: "CollectImages" | "DispatchImages" }>,
    ) => {
      const collecting = batch?._tag === "Collecting" ? batch : undefined;
      const compatible =
        collecting?.sessionId === event.sessionId && collecting.userId === event.userId;
      if (batch !== undefined && !compatible) return undefined;
      const duplicate = collecting?.messageIds.includes(event.messageId) === true;
      const messageIds = duplicate
        ? collecting.messageIds
        : collecting
          ? [...collecting.messageIds, event.messageId]
          : [event.messageId];
      return {
        messageIds,
        images: duplicate
          ? collecting.images
          : collecting
            ? [...collecting.images, ...event.images]
            : [...event.images],
      };
    };

    const beginCollectedDispatch = (state: BridgeState): BridgeState => {
      const pending = state.pendingImageBatch;
      if (pending?._tag !== "Collecting") return state;
      return {
        ...state,
        pendingImageBatch: {
          _tag: "Dispatching",
          sessionId: pending.sessionId,
          userId: pending.userId,
          messageIds: pending.messageIds,
          images: pending.images,
          contextToken: pending.contextToken,
          requestId: messageBatchIdentity(pending.messageIds),
          prompt: pending.images.length === 1 ? "请分析图片。" : "请分析这些图片。",
        },
      };
    };

    const transitionInbound = (event: InboundStateEvent) =>
      update((state) => {
        switch (event._tag) {
          case "CollectImages": {
            if (state.pendingImageBatch?._tag === "Dispatching") return state;
            const batch = appendBatch(state.pendingImageBatch, event);
            if (batch === undefined) return state;
            return withProcessed(
              {
                ...state,
                pendingImageBatch: {
                  _tag: "Collecting",
                  sessionId: event.sessionId,
                  userId: event.userId,
                  messageIds: batch.messageIds,
                  images: batch.images,
                  contextToken: event.contextToken,
                  deadlineAt: event.deadlineAt,
                },
              },
              event.messageId,
            );
          }
          case "DispatchImages": {
            if (state.pendingImageBatch?._tag === "Dispatching") return state;
            const batch = appendBatch(state.pendingImageBatch, event);
            if (batch === undefined) return state;
            if (batch.images.length === 0) return state;
            const requestId = messageBatchIdentity(batch.messageIds);
            return withProcessed(
              {
                ...state,
                pendingImageBatch: {
                  _tag: "Dispatching",
                  sessionId: event.sessionId,
                  userId: event.userId,
                  messageIds: batch.messageIds,
                  images: batch.images,
                  contextToken: event.contextToken,
                  requestId,
                  prompt: event.prompt,
                },
              },
              event.messageId,
            );
          }
          case "FlushImages":
            return beginCollectedDispatch(state);
          case "ExpireImages": {
            const pending = state.pendingImageBatch;
            if (pending?._tag !== "Collecting" || event.now < pending.deadlineAt) return state;
            return beginCollectedDispatch(state);
          }
          case "CompleteImages": {
            if (
              state.pendingImageBatch?._tag !== "Dispatching" ||
              state.pendingImageBatch.requestId !== event.requestId
            ) {
              return state;
            }
            const { pendingImageBatch: _pending, ...complete } = state;
            return complete;
          }
        }
      });

    return {
      path: statePath,
      read,
      write,
      saveAuth: (auth) =>
        update((state) => {
          const { pendingImageBatch: _pending, ...stable } = state;
          return {
            ...stable,
            auth,
            cursor: "",
            processedMessageIds: [],
          };
        }),
      clearAuth: update((state) => {
        const { auth: _auth, pendingImageBatch: _pending, ...withoutAuth } = state;
        return {
          ...withoutAuth,
          cursor: "",
          processedMessageIds: [],
        };
      }),
      bind: (binding) => update((state) => ({ ...state, binding, enabled: true })),
      setEnabled: (enabled) => update((state) => ({ ...state, enabled })),
      markProcessed: (messageId) => update((state) => withProcessed(state, messageId)),
      saveCursor: (cursor) => update((state) => ({ ...state, cursor })),
      transitionInbound,
      logout: write(EMPTY_STATE).pipe(Effect.as(EMPTY_STATE)),
    };
  });
