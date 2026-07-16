import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { fileURLToPath } from "node:url";
import { withTestStore } from "./runtime.ts";

const hasPosixFileModes = process.platform !== "win32";

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
        yield* store.bind({ sessionId: "session", cwd: "/tmp" });
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

it.effect("clearing stale credentials preserves the session binding and enabled intent", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      yield* store.saveAuth({
        token: "stale",
        baseUrl: "https://example.test",
        accountId: "bot",
        userId: "user",
        savedAt: "now",
      });
      yield* store.bind({ sessionId: "session", cwd: "/tmp" });
      yield* store.saveCursor("cursor");
      yield* store.markProcessed("message-1");

      const state = yield* store.clearAuth;
      expect(state.auth).toBeUndefined();
      expect(state.binding?.sessionId).toBe("session");
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

it.effect("atomically migrates the published v1 state without losing credentials or binding", () =>
  withTestStore((store) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* fs.readFileString(
        fileURLToPath(
          new URL("../../../tests/upgrade-fixtures/pi-weixin-state-v1.json", import.meta.url),
        ),
      );
      yield* fs.writeFileString(store.path, fixture);

      const migrated = yield* store.read;
      expect(migrated).toMatchObject({
        version: 2,
        enabled: true,
        cursor: "legacy-cursor",
        auth: { accountId: "legacy-bot" },
        binding: { sessionId: "legacy-session" },
      });
      expect(JSON.parse(yield* fs.readFileString(store.path))).toEqual(migrated);
    }),
  ),
);
