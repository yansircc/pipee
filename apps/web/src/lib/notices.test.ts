import assert from "node:assert/strict"
import { test } from "vite-plus/test"

async function loadSubject() {
  return import("./notices")
}

test("extension notifications and actionable severities stay until dismissed", async () => {
  const { createNotice } = await loadSubject()

  assert.equal(
    createNotice({ id: "extension", message: "token", type: "info", source: "extension" }).dismissMode,
    "manual",
  )
  assert.equal(
    createNotice({ id: "warning", message: "warning", type: "warning", source: "app" }).dismissMode,
    "manual",
  )
  assert.equal(createNotice({ id: "error", message: "error", type: "error", source: "app" }).dismissMode, "manual")
  assert.equal(createNotice({ id: "success", message: "done", type: "success", source: "app" }).dismissMode, "auto")
})

test("a durable notification evicts only a transient notification", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const persistent = Array.from({ length: MAX_VISIBLE_NOTICES - 1 }, (_, index) =>
    createNotice({ id: `manual-${index}`, message: "keep", type: "warning", source: "app" }),
  )
  const transient = createNotice({ id: "auto", message: "temporary", type: "info", source: "app" })
  const durable = createNotice({ id: "token", message: "pairing token", type: "info", source: "extension" })

  const next = noticeReducer({ visible: [...persistent, transient], pending: [] }, { type: "add", notice: durable })

  assert.equal(next.visible.find((notice) => notice.id === "auto")?.exiting, true)
  assert.equal(
    next.visible.some((notice) => notice.id.startsWith("manual-") && notice.exiting),
    false,
  )
  assert.deepEqual(
    next.pending.map((notice) => notice.id),
    ["token"],
  )
})

test("a full durable shelf queues durable notices and drops stale transient notices", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const visible = Array.from({ length: MAX_VISIBLE_NOTICES }, (_, index) =>
    createNotice({ id: `manual-${index}`, message: "keep", type: "error", source: "app" }),
  )
  const durable = createNotice({ id: "token", message: "pairing token", type: "info", source: "extension" })
  const transient = createNotice({ id: "success", message: "done", type: "success", source: "app" })

  const queued = noticeReducer({ visible, pending: [] }, { type: "add", notice: durable })
  const unchanged = noticeReducer(queued, { type: "add", notice: transient })

  assert.deepEqual(
    queued.pending.map((notice) => notice.id),
    ["token"],
  )
  assert.deepEqual(
    unchanged.pending.map((notice) => notice.id),
    ["token"],
  )
})

test("dismissing a durable notice reveals the next queued durable notice", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const visible = Array.from({ length: MAX_VISIBLE_NOTICES }, (_, index) =>
    createNotice({ id: `manual-${index}`, message: "keep", type: "warning", source: "app" }),
  )
  const queued = createNotice({ id: "queued", message: "next", type: "info", source: "extension" })
  const state = { visible, pending: [queued] }

  const dismissing = noticeReducer(state, { type: "dismiss", id: "manual-0" })
  const revealed = noticeReducer(dismissing, { type: "remove", id: "manual-0" })

  assert.equal(dismissing.visible[0].exiting, true)
  assert.equal(
    revealed.visible.some((notice) => notice.id === "queued"),
    true,
  )
  assert.equal(revealed.pending.length, 0)
})
