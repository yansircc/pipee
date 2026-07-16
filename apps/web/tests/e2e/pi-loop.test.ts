import { expect, test } from "@playwright/test"

const extensionPath = process.env.PI_WEB_E2E_EXTENSION_PATH

test("controls the real pi-loop extension through structured status", async ({ page }) => {
  test.skip(extensionPath === undefined, "set PI_WEB_E2E_EXTENSION_PATH for the paired extension gate")
  await page.goto("/")
  const sessionId = "00000000-0000-4000-8000-000000000001"
  const command = async (action: unknown) =>
    page.evaluate(
      async ({ sessionId, action }) => {
        const response = await fetch(`/api/sessions/${sessionId}/companions/loop/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "pi-loop/control", version: 1, action }),
        })
        return { status: response.status, body: await response.json() }
      },
      { sessionId, action },
    )
  const projection = () =>
    page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}?deferThinking=1&deferMedia=1`)
      const snapshot = await response.json()
      return snapshot.runtime.extensionUi
    }, sessionId)

  const first = await command({ _tag: "CreateInterval", periodMs: 60_000, prompt: "inspect alpha" })
  expect(first.status, JSON.stringify(first.body)).toBe(200)
  const second = await command({ _tag: "CreateInterval", periodMs: 120_000, prompt: "inspect beta" })
  expect(second.status, JSON.stringify(second.body)).toBe(200)
  expect(second.body).toEqual({ ok: true })
  await expect.poll(projection).toMatchObject({
    statuses: expect.arrayContaining([
      expect.objectContaining({
        _tag: "Structured",
        key: "pi-loop",
        value: expect.objectContaining({
          kind: "pi-loop/status",
          loops: [
            expect.objectContaining({ prompt: "inspect alpha" }),
            expect.objectContaining({ prompt: "inspect beta" }),
          ],
        }),
      }),
      expect.objectContaining({ key: "pi-loop/runtime-lease" }),
    ]),
  })

  const current = await projection()
  const loops = current.statuses.find(
    (item: { key?: string; value?: { loops?: Array<{ id: string }> } }) => item.key === "pi-loop",
  )?.value.loops
  expect(loops).toHaveLength(2)
  const firstDelete = await command({ _tag: "Delete", id: loops[0].id })
  expect(firstDelete.status).toBe(200)
  const secondDelete = await command({ _tag: "Delete", id: loops[1].id })
  expect(secondDelete.status).toBe(200)
  await expect
    .poll(async () =>
      (await projection()).statuses.some((item: { key?: string }) => item.key === "pi-loop/runtime-lease"),
    )
    .toBe(false)
})
