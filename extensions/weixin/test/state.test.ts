import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { makeStateStore } from "../src/state.ts";
import { withTestStore } from "./runtime.ts";

const hasPosixFileModes = process.platform !== "win32";

it.effect("migrates v2 binding to the v3 default session without losing auth", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        store.path,
        JSON.stringify({
          version: 2,
          enabled: true,
          cursor: "cursor",
          processedMessageIds: ["message-1"],
          auth: {
            token: "secret",
            baseUrl: "https://example.test",
            accountId: "bot",
            userId: "user",
            savedAt: "now",
          },
          binding: { sessionId: "session-v2", cwd: "/tmp" },
        }),
      );
      const migrated = yield* makeStateStore(store.path);
      const state = yield* migrated.read;
      expect(state).toMatchObject({
        version: 3,
        enabled: true,
        cursor: "cursor",
        defaultSession: { sessionId: "session-v2", cwd: "/tmp" },
        auth: { accountId: "bot" },
      });
      expect(JSON.parse(yield* fs.readFileString(store.path)).version).toBe(3);
    }),
  ),
);

it.effect("state store persists auth and bounds processed ids", () =>
  withTestStore(
    (store) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* store.saveAuth({
          token: "secret",
          baseUrl: "https://example.test",
          accountId: "bot",
          userId: "user",
          savedAt: "now",
        });
        yield* store.setDefaultSession({ sessionId: "session", cwd: "/tmp" });
        yield* store.markProcessed("one");
        yield* store.markProcessed("two");
        yield* store.markProcessed("three");

        const state = yield* store.read;
        const info = yield* fs.stat(store.path);
        const encoded = yield* fs.readFileString(store.path);
        expect(state.processedMessageIds).toEqual(["two", "three"]);
        if (hasPosixFileModes) expect(info.mode & 0o777).toBe(0o600);
        expect(encoded).not.toMatch(/\.tmp/);
      }),
    2,
  ),
);

it.effect("clearing stale credentials preserves the default session and enabled intent", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.saveAuth({
        token: "stale",
        baseUrl: "https://example.test",
        accountId: "bot",
        userId: "user",
        savedAt: "now",
      });
      yield* store.setDefaultSession({ sessionId: "session", cwd: "/tmp" });
      yield* store.setEnabled(true);
      yield* store.saveCursor("cursor");
      yield* store.markProcessed("message-1");

      const state = yield* store.clearAuth;
      expect(state.auth).toBeUndefined();
      expect(state.defaultSession?.sessionId).toBe("session");
      expect(state.enabled).toBe(true);
      expect(state.cursor).toBe("");
      expect(state.processedMessageIds).toEqual([]);
    }),
  ),
);

it.effect("collecting the same message twice cannot duplicate its image", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      const event = {
        _tag: "CollectImages" as const,
        sessionId: "session",
        userId: "user",
        messageId: "message-1",
        images: [{ media: { encrypt_query_param: "image-1" } }],
        contextToken: "context",
        deadlineAt: 30_000,
      };
      yield* store.transitionInbound(event);
      yield* store.transitionInbound(event);

      const state = yield* store.read;
      expect(state.pendingImageBatch?._tag).toBe("Collecting");
      expect(state.pendingImageBatch?.messageIds).toEqual(["message-1"]);
      expect(state.pendingImageBatch?.images).toHaveLength(1);
      expect(state.processedMessageIds).toEqual(["message-1"]);
    }),
  ),
);

it.effect("a different batch owner cannot overwrite a durable collecting batch", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.transitionInbound({
        _tag: "CollectImages",
        sessionId: "old-session",
        userId: "user",
        messageId: "old-message",
        images: [{ media: { encrypt_query_param: "old-image" } }],
        contextToken: "old-context",
        deadlineAt: 30_000,
      });
      const state = yield* store.transitionInbound({
        _tag: "CollectImages",
        sessionId: "new-session",
        userId: "user",
        messageId: "new-message",
        images: [{ media: { encrypt_query_param: "new-image" } }],
        contextToken: "new-context",
        deadlineAt: 31_000,
      });

      expect(state.pendingImageBatch).toMatchObject({
        _tag: "Collecting",
        sessionId: "old-session",
        messageIds: ["old-message"],
      });
      expect(state.processedMessageIds).toEqual(["old-message"]);
    }),
  ),
);

it.effect("clearing auth removes its owned pending image batch", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.transitionInbound({
        _tag: "CollectImages",
        sessionId: "session",
        userId: "user",
        messageId: "message",
        images: [{ media: { encrypt_query_param: "image" } }],
        contextToken: "context",
        deadlineAt: 30_000,
      });

      expect((yield* store.clearAuth).pendingImageBatch).toBeUndefined();
    }),
  ),
);
