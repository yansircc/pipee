import assert from "node:assert/strict"
import { test } from "vite-plus/test"

async function loadSubject() {
  return import("./notices")
}

test("every toast severity and source participates in auto dismissal", async () => {
  const { createNotice, getNextAutoDismissNotice } = await loadSubject()
  const notices = [
    createNotice({ id: "extension", message: "token", type: "info", source: "extension" }),
    createNotice({ id: "warning", message: "warning", type: "warning", source: "app" }),
    createNotice({ id: "error", message: "error", type: "error", source: "app" }),
    createNotice({ id: "success", message: "done", type: "success", source: "app" }),
  ]

  for (const notice of notices) {
    assert.equal(getNextAutoDismissNotice({ visible: [notice], pending: [] })?.id, notice.id)
  }
})

test("a full shelf evicts its oldest toast for the next notification", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const visible = Array.from({ length: MAX_VISIBLE_NOTICES }, (_, index) =>
    createNotice({ id: `notice-${index}`, message: "visible", type: "error", source: "app" }),
  )
  const incoming = createNotice({ id: "incoming", message: "next", type: "info", source: "extension" })

  const next = noticeReducer({ visible, pending: [] }, { type: "add", notice: incoming })

  assert.equal(next.visible[0]?.exiting, true)
  assert.deepEqual(
    next.pending.map((notice) => notice.id),
    ["incoming"],
  )
})

test("a shelf that is already exiting queues every new toast", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const visible = Array.from({ length: MAX_VISIBLE_NOTICES }, (_, index) => ({
    ...createNotice({ id: `notice-${index}`, message: "visible", type: "error", source: "app" }),
    ...(index === 0 ? { exiting: true } : {}),
  }))
  const first = createNotice({ id: "first", message: "first", type: "info", source: "extension" })
  const second = createNotice({ id: "second", message: "second", type: "success", source: "app" })

  const queued = noticeReducer({ visible, pending: [] }, { type: "add", notice: first })
  const next = noticeReducer(queued, { type: "add", notice: second })

  assert.deepEqual(
    next.pending.map((notice) => notice.id),
    ["first", "second"],
  )
})

test("dismissing a toast reveals the next queued toast", async () => {
  const { createNotice, MAX_VISIBLE_NOTICES, noticeReducer } = await loadSubject()
  const visible = Array.from({ length: MAX_VISIBLE_NOTICES }, (_, index) =>
    createNotice({ id: `notice-${index}`, message: "visible", type: "warning", source: "app" }),
  )
  const queued = createNotice({ id: "queued", message: "next", type: "info", source: "extension" })
  const state = { visible, pending: [queued] }

  const dismissing = noticeReducer(state, { type: "dismiss", id: "notice-0" })
  const revealed = noticeReducer(dismissing, { type: "remove", id: "notice-0" })

  assert.equal(dismissing.visible[0].exiting, true)
  assert.equal(
    revealed.visible.some((notice) => notice.id === "queued"),
    true,
  )
  assert.equal(revealed.pending.length, 0)
})

test("replayed extension notices are idempotent by server notice id", async () => {
  const { createNotice, noticeReducer } = await loadSubject()
  const notice = createNotice({ id: "server-notice-1", message: "paired", type: "info", source: "extension" })
  const initial = { visible: [], pending: [] }
  const added = noticeReducer(initial, { type: "add", notice })

  assert.equal(noticeReducer(added, { type: "add", notice }), added)
})
