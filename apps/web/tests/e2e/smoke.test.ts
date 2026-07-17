import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import pkg from "../../package.json" with { type: "json" }

const fixtureWorkspace = resolve("test-results/e2e-fixture/workspace")
const fixturePluginDirectory = resolve("test-results/e2e-fixture/e2e-plugin")
const fixtureNpmCommandLog = resolve("test-results/e2e-fixture/npm-command.log")
const fixtureSettingsPath = resolve("test-results/e2e-fixture/home/.pi/agent/settings.json")
const nonGitWorkspace = resolve(tmpdir(), "pi-web-e2e-non-git-workspace")

const mutate = (page: Page, url: string, body: unknown, method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST") =>
  page.evaluate(
    async ({ url, body, method }) => {
      const init = { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      const response = await (method === "DELETE"
        ? fetch(url, { ...init, method: "DELETE" })
        : method === "PATCH"
          ? fetch(url, { ...init, method: "PATCH" })
          : method === "PUT"
            ? fetch(url, { ...init, method: "PUT" })
            : fetch(url, { ...init, method: "POST" }))
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    },
    { url, body, method },
  )

const waitForBashEvent = (page: Page, sessionId: string, executionId: string, tag: "BashStarted" | "BashFinished") =>
  page.evaluate(
    async ({ sessionId, executionId, tag }) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetch(`/api/sessions/${sessionId}/events`, { signal: controller.signal })
        const reader = response.body?.getReader()
        if (reader === undefined) throw new Error("session event stream has no body")
        const decoder = new TextDecoder()
        let buffer = ""
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const frames = buffer.split("\n\n")
          buffer = frames.pop() ?? ""
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .find((line) => line.startsWith("data:"))
              ?.slice(5)
              .trim()
            if (!data) continue
            const envelope = JSON.parse(data) as {
              event: {
                _tag: string
                execution?: { id: string; message?: unknown }
                id?: string
              }
            }
            const event = envelope.event
            const id = event.execution?.id ?? event.id
            if (event._tag === tag && id === executionId) return event
          }
        }
        throw new Error(`bash event stream ended before ${tag}: ${executionId}`)
      } finally {
        clearTimeout(timeout)
        controller.abort()
      }
    },
    { sessionId, executionId, tag },
  )

test("serves the Start shell and typed health metadata", async ({ page, request }) => {
  const health = await request.get("/api/health")
  expect(health.ok()).toBe(true)
  await expect(health.json()).resolves.toMatchObject({
    status: "ok",
    appVersion: pkg.version,
    piVersion: "0.80.6",
  })

  await page.goto("/")
  await expect(page).toHaveTitle("Pi Agent Web")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(page.getByText("Pi Agent Web", { exact: true }).first()).toBeVisible()
})

test("persists visible locale and theme preferences", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "切换语言" }).click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await page.getByRole("button", { name: "Switch to dark mode" }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(page.getByRole("button", { name: "Switch language" })).toHaveText("中文")
})

test("canonicalizes an invalid session URL after the session index loads", async ({ page }) => {
  await page.goto("/?session=missing-session")
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText("Pi Agent Web", { exact: true }).first()).toBeVisible()
})

test("renders the root not-found boundary", async ({ page }) => {
  const response = await page.goto("/missing-route")
  expect(response?.status()).toBe(404)
  await expect(page.getByRole("heading", { name: "Not Found" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Pi Agent Web" })).toHaveAttribute("href", "/")
})

test("renders the provider failure owned by an empty assistant message", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000002")
  await expect(page.getByRole("alert")).toContainText("Fixture provider timed out.")
})

test("follows live output until the user scrolls away and offers a return to latest", async ({ page }) => {
  const sessionId = "00000000-0000-4000-8000-000000000003"
  await page.goto(`/?session=${sessionId}`)
  const scroller = page.getByTestId("chat-scroll-container")
  await expect(scroller).toBeVisible()
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0)

  await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible()

  const running = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "detached-scroll-output",
    command: "for i in $(seq 1 40); do printf 'live-output-%s\\n' \"$i\"; sleep 0.02; done",
    excludeFromContext: true,
  })
  expect(running.status).toBe(200)
  await waitForBashEvent(page, sessionId, "detached-scroll-output", "BashFinished")
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(2)

  await page.getByRole("button", { name: "回到最新消息" }).click()
  await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test("projects an active session before Pi persists its first message", async ({ page }) => {
  await page.goto("/")
  await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  const created = await mutate(page, "/api/sessions", { cwd: fixtureWorkspace, toolNames: [] })
  expect(created.status).toBe(200)
  const sessionId = (created.body as { id: string }).id

  const index = await page.evaluate(async () => {
    const response = await fetch("/api/sessions")
    return { status: response.status, body: await response.json() }
  })
  expect(index.status, JSON.stringify(index.body)).toBe(200)
  expect(index.body.sessions).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: sessionId, cwd: fixtureWorkspace })]),
  )

  const snapshot = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}?deferThinking=1&deferMedia=1`)
    return { status: response.status, body: await response.json() }
  }, sessionId)
  expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200)
  expect(snapshot.body).toMatchObject({
    sessionId,
    context: { messages: [], entryIds: [] },
    runtime: { sessionId },
  })
  const tools = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}/tools`)
    return { status: response.status, body: await response.json() }
  }, sessionId)
  expect(tools.status, JSON.stringify(tools.body)).toBe(200)
  expect(tools.body.tools).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "set_session_name", active: true })]),
  )

  const removed = await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
  expect(removed.status).toBe(200)
})

test("creates only from a canonical admitted cwd and cleans failed configuration", async ({ page }) => {
  await page.goto("/")
  const aliasedWorkspace = `${fixtureWorkspace}/../workspace`
  const before = await page.evaluate(async () => (await fetch("/api/sessions")).json())

  const failed = await mutate(page, "/api/sessions", {
    cwd: aliasedWorkspace,
    model: { provider: "missing-provider", modelId: "missing-model" },
    toolNames: [],
  })
  expect(failed.status).toBe(500)

  const afterFailure = await page.evaluate(async () => (await fetch("/api/sessions")).json())
  expect(afterFailure.sessions).toEqual(before.sessions)

  const created = await mutate(page, "/api/sessions", { cwd: aliasedWorkspace, toolNames: [] })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  expect(created.body).toMatchObject({ cwd: fixtureWorkspace })
  const retried = await mutate(page, "/api/sessions", { cwd: fixtureWorkspace, toolNames: [] })
  expect(retried.body.id).toBe(created.body.id)
  const differentlyConfigured = await mutate(page, "/api/sessions", {
    cwd: fixtureWorkspace,
    toolNames: ["read"],
  })
  expect(differentlyConfigured.status, JSON.stringify(differentlyConfigured.body)).toBe(200)
  expect(differentlyConfigured.body.id).not.toBe(created.body.id)
  await mutate(page, `/api/sessions/${differentlyConfigured.body.id}`, {}, "DELETE")
  await mutate(page, `/api/sessions/${created.body.id}`, {}, "DELETE")
})

test("resolves a session-scoped extension interaction before any run exists", async ({ page }) => {
  await page.goto("/")
  await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  const created = await mutate(page, "/api/sessions", { cwd: fixtureWorkspace, toolNames: [] })
  expect(created.status).toBe(200)
  const sessionId = (created.body as { id: string }).id
  await page.goto(`/?session=${sessionId}`)
  await expect(page.locator("textarea").first()).toBeVisible()

  await page.evaluate((id) => {
    const state = window as typeof window & { interactionResult?: unknown }
    void fetch(`/api/sessions/${id}/actions/slash-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "interaction-test", args: "" }),
    })
      .then(async (response) => ({ status: response.status, body: await response.json() }))
      .then((result) => {
        state.interactionResult = result
      })
  }, sessionId)

  await expect(page.getByText("E2E interaction", { exact: true })).toBeVisible()
  const pending = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}?deferThinking=1&deferMedia=1`)
    const snapshot = await response.json()
    return {
      runtimeId: snapshot.runtime.identity.runtimeId as string,
      interactionId: snapshot.runtime.extensionUi.pendingInteraction.interactionId as string,
    }
  }, sessionId)
  const staleRuntime = await mutate(
    page,
    `/api/sessions/${sessionId}/runtimes/00000000-0000-4000-8000-000000000099/interactions/${pending.interactionId}/resolve`,
    { answer: { _tag: "Value", value: "stale" } },
  )
  expect(staleRuntime.status).toBe(409)
  const wrongKind = await mutate(
    page,
    `/api/sessions/${sessionId}/runtimes/${pending.runtimeId}/interactions/${pending.interactionId}/resolve`,
    { answer: { _tag: "Confirmation", confirmed: true } },
  )
  expect(wrongKind.status).toBe(400)
  await page.getByPlaceholder("pairing code").fill("2468")
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { interactionResult?: unknown }).interactionResult ?? null),
    )
    .toMatchObject({
      status: 200,
      body: { ok: true },
    })

  const snapshot = () =>
    page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}?deferThinking=1&deferMedia=1`)
      return response.json()
    }, sessionId)
  await expect.poll(snapshot).toMatchObject({
    runtime: {
      runId: null,
      extensionUi: {
        pendingInteraction: null,
        statuses: expect.arrayContaining([{ _tag: "Text", key: "e2e-interaction", text: "resolved:2468" }]),
      },
    },
  })
  const duplicate = await mutate(
    page,
    `/api/sessions/${sessionId}/runtimes/${pending.runtimeId}/interactions/${pending.interactionId}/resolve`,
    { answer: { _tag: "Value", value: "duplicate" } },
  )
  expect(duplicate.status).toBe(409)

  await page.evaluate((id) => {
    const state = window as typeof window & { interactionQueueResult?: unknown }
    void fetch(`/api/sessions/${id}/actions/slash-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "interaction-queue-test", args: "" }),
    })
      .then(async (response) => ({ status: response.status, body: await response.json() }))
      .then((result) => {
        state.interactionQueueResult = result
      })
  }, sessionId)
  await expect(page.getByText("First interaction", { exact: true })).toBeVisible()
  await page.getByPlaceholder("first value").fill("alpha")
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect(page.getByText("Second interaction", { exact: true })).toBeVisible()
  await page.getByPlaceholder("second value").fill("beta")
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { interactionQueueResult?: unknown }).interactionQueueResult ?? null,
      ),
    )
    .toMatchObject({ status: 200, body: { ok: true } })
  await expect.poll(snapshot).toMatchObject({
    runtime: {
      extensionUi: {
        statuses: expect.arrayContaining([{ _tag: "Text", key: "e2e-interaction-queue", text: "alpha:beta" }]),
      },
    },
  })

  const timed = await mutate(page, `/api/sessions/${sessionId}/actions/slash-command`, {
    name: "interaction-timeout-test",
    args: "",
  })
  expect(timed).toMatchObject({ status: 200, body: { ok: true } })
  await expect.poll(snapshot).toMatchObject({
    runtime: {
      runId: null,
      extensionUi: {
        pendingInteraction: null,
        statuses: expect.arrayContaining([{ _tag: "Text", key: "e2e-interaction-timeout", text: "cancelled" }]),
      },
    },
  })

  await page.evaluate((id) => {
    const state = window as typeof window & { interactionAbortResult?: unknown }
    void fetch(`/api/sessions/${id}/actions/slash-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "interaction-abort-test", args: "" }),
    })
      .then(async (response) => ({ status: response.status, body: await response.json() }))
      .then((result) => {
        state.interactionAbortResult = result
      })
  }, sessionId)
  await expect(page.getByText("Abort blocker", { exact: true })).toBeVisible()
  await expect(page.getByText("Aborted interaction", { exact: true })).toHaveCount(0)
  await page.getByPlaceholder("resolve blocker").fill("done")
  await page.getByRole("button", { name: "Submit", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { interactionAbortResult?: unknown }).interactionAbortResult),
    )
    .toMatchObject({ status: 200, body: { ok: true } })
  await expect.poll(snapshot).toMatchObject({
    runtime: {
      extensionUi: {
        statuses: expect.arrayContaining([{ _tag: "Text", key: "e2e-interaction-abort", text: "undefined:done" }]),
      },
    },
  })

  await page.evaluate((id) => {
    const state = window as typeof window & { interactionCloseResult?: unknown }
    void fetch(`/api/sessions/${id}/actions/slash-command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "interaction-close-test", args: "" }),
    })
      .then(async (response) => ({ status: response.status, body: await response.json() }))
      .then((result) => {
        state.interactionCloseResult = result
      })
  }, sessionId)
  await expect(page.getByText("Close active interaction", { exact: true })).toBeVisible()

  const removed = await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
  expect(removed.status).toBe(200)
  await expect
    .poll(() =>
      page.evaluate(() => (window as typeof window & { interactionCloseResult?: unknown }).interactionCloseResult),
    )
    .toMatchObject({ status: 200, body: { ok: true } })
})

test("materializes a new session before exposing the conversation UI", async ({ page }) => {
  await page.goto("/")
  let createRequests = 0
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sessions") createRequests += 1
  })
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 250))
    await route.continue()
  })
  const create = page.getByRole("button", { name: "新建", exact: true })
  await expect(create).toBeEnabled()
  await create.click()
  await expect(page.getByRole("button", { name: "加载中…", exact: true })).toBeDisabled()

  await expect(page).toHaveURL(/\?session=/)
  const sessionId = new URL(page.url()).searchParams.get("session")
  expect(sessionId).toBeTruthy()
  const row = page.locator(`[data-session-id="${sessionId}"]`)
  await expect(row).toContainText("(no messages)")

  const input = page.locator("textarea").first()
  await expect(input).toBeFocused()
  await input.fill("/")
  await expect(page.getByText("/skill:e2e-skill", { exact: true })).toBeVisible()

  await create.click()
  await expect(page).toHaveURL(new RegExp(`\\?session=${sessionId}$`))
  await expect(input).toBeFocused()
  expect(createRequests).toBe(2)

  const removed = await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
  expect(removed.status).toBe(200)
})

test("deleting the selected session does not issue late session-owned requests", async ({ page }) => {
  await page.goto("/")
  await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  const created = await mutate(page, "/api/sessions", { cwd: fixtureWorkspace, toolNames: [] })
  expect(created.status).toBe(200)
  const sessionId = (created.body as { id: string }).id
  const toolsPath = `/api/sessions/${sessionId}/tools`
  const lateToolRequests: string[] = []
  const lifecycleErrors: string[] = []
  let deletionCompleted = false

  page.on("response", (response) => {
    if (response.request().method() === "DELETE" && response.url().endsWith(`/api/sessions/${sessionId}`)) {
      deletionCompleted = response.ok()
    }
  })
  page.on("request", (request) => {
    if (deletionCompleted && request.url().endsWith(toolsPath)) lateToolRequests.push(request.url())
  })
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") lifecycleErrors.push(message.text())
  })

  await page.goto(`/?session=${sessionId}`)
  const row = page.locator(`[data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible()
  await row.hover()
  await row.getByRole("button", { name: "删除", exact: true }).click()
  await row.getByRole("button", { name: "删除", exact: true }).click()

  await expect(row).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  await page.waitForTimeout(500)

  expect(lateToolRequests).toEqual([])
  expect(lifecycleErrors.filter((message) => message.includes("hasn't mounted yet"))).toEqual([])
})

test("opens the running-session SSE contract", async ({ page }) => {
  await page.goto("/")
  const result = await page.evaluate(async () => {
    const controller = new AbortController()
    const response = await fetch("/api/sessions/running/events", { signal: controller.signal })
    const contentType = response.headers.get("content-type")
    controller.abort()
    return { status: response.status, contentType }
  })
  expect(result.status).toBe(200)
  expect(result.contentType).toContain("text/event-stream")
})

test("rejects cross-site mutations before domain execution", async ({ request }) => {
  const response = await request.post("/api/workspace/cwd/validate", {
    headers: {
      origin: "https://attacker.invalid",
      "sec-fetch-site": "cross-site",
    },
    data: { cwd: "/tmp" },
  })
  expect(response.status()).toBe(403)
  await expect(response.json()).resolves.toMatchObject({
    _tag: "Forbidden",
    message: "Cross-site API requests are forbidden",
  })

  const read = await request.get("/api/sessions", {
    headers: { "sec-fetch-site": "cross-site" },
  })
  expect(read.status()).toBe(403)
})

test("rejects files outside the server-owned allowed-root policy", async ({ request, baseURL }) => {
  const response = await request.get("/api/workspace/files/read", {
    params: { path: "/etc/passwd" },
  })
  expect(response.status()).toBe(403)
  await expect(response.json()).resolves.toMatchObject({
    _tag: "Forbidden",
  })

  const skillMutation = await request.patch("/api/packages/skills", {
    headers: { origin: baseURL },
    data: { cwd: fixtureWorkspace, filePath: "/etc/passwd", disableModelInvocation: true },
  })
  expect(skillMutation.status()).toBe(403)
  await expect(skillMutation.json()).resolves.toMatchObject({ _tag: "Forbidden" })

  const nonSkillMutation = await request.patch("/api/packages/skills", {
    headers: { origin: baseURL },
    data: {
      cwd: fixtureWorkspace,
      filePath: resolve(fixtureWorkspace, "hello.txt"),
      disableModelInvocation: true,
    },
  })
  expect(nonSkillMutation.status()).toBe(403)

  const missingProjectCwd = await request.post("/api/packages/skills/install", {
    headers: { origin: baseURL },
    data: { package: "owner/skill", scope: "project" },
  })
  expect(missingProjectCwd.status()).toBe(400)

  const pluginMutation = await request.post("/api/packages/plugins/actions", {
    headers: { origin: baseURL },
    data: { cwd: fixtureWorkspace, action: "install", source: "/path/that/does/not/exist", scope: "project" },
  })
  expect(pluginMutation.status()).toBe(403)
  await expect(pluginMutation.json()).resolves.toMatchObject({ _tag: "Forbidden" })
})

test("validates cwd, reads files, and reports dirty worktrees structurally", async ({ page }) => {
  await page.goto("/")
  await rm(nonGitWorkspace, { recursive: true, force: true })
  await mkdir(nonGitWorkspace, { recursive: true })
  const validatedNonGit = await mutate(page, "/api/workspace/cwd/validate", { cwd: nonGitWorkspace })
  expect(validatedNonGit.status).toBe(200)
  const canonicalNonGitWorkspace = (validatedNonGit.body as { cwd: string }).cwd
  const nonGitWorktrees = await page.evaluate(async (cwd) => {
    const response = await fetch(`/api/workspace/worktrees?cwd=${encodeURIComponent(cwd)}`)
    return { status: response.status, body: await response.json() }
  }, nonGitWorkspace)
  expect(nonGitWorktrees).toMatchObject({
    status: 200,
    body: {
      worktrees: [],
      project: { projectRoot: canonicalNonGitWorkspace, branch: null, isWorktree: false, isTopLevel: false },
    },
  })
  await rm(nonGitWorkspace, { recursive: true, force: true })

  const validated = await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  expect(validated.status).toBe(200)
  expect(validated.body).toMatchObject({ cwd: fixtureWorkspace })

  const file = await page.evaluate(
    async (path) => {
      const response = await fetch(`/api/workspace/files/read?path=${encodeURIComponent(path)}`)
      return { status: response.status, body: await response.json() }
    },
    resolve(fixtureWorkspace, "hello.txt"),
  )
  expect(file.status).toBe(200)
  expect(file.body).toMatchObject({
    encoding: "utf8",
    content: "hello from the isolated e2e workspace\n",
  })

  const created = await mutate(page, "/api/workspace/worktrees", {
    cwd: fixtureWorkspace,
    branch: "e2e-dirty-conflict",
  })
  expect(created.status).toBe(200)
  expect(created.body).toMatchObject({ branch: "e2e-dirty-conflict" })
  const worktreePath = (created.body as { path: string }).path
  await writeFile(resolve(worktreePath, "dirty.txt"), "uncommitted\n")

  const conflict = await mutate(
    page,
    "/api/workspace/worktrees",
    {
      cwd: fixtureWorkspace,
      path: worktreePath,
      force: false,
    },
    "DELETE",
  )
  expect(conflict.status, JSON.stringify(conflict.body)).toBe(409)
  expect(conflict.body).toMatchObject({
    _tag: "Conflict",
    detail: { _tag: "DirtyWorktree", path: worktreePath },
  })

  const removed = await mutate(
    page,
    "/api/workspace/worktrees",
    {
      cwd: fixtureWorkspace,
      path: worktreePath,
      force: true,
    },
    "DELETE",
  )
  expect(removed.status).toBe(200)
})

test("runs and aborts Pi-native bash inside an isolated session", async ({ page }) => {
  test.setTimeout(30_000)
  await page.goto("/")
  await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  const created = await mutate(page, "/api/sessions", { cwd: fixtureWorkspace, toolNames: [] })
  expect(created.status).toBe(200)
  const sessionId = (created.body as { id: string }).id

  const completed = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "bash-complete",
    command: "printf e2e-bash",
    excludeFromContext: false,
  })
  expect(completed.status, JSON.stringify(completed.body)).toBe(200)
  expect(completed.body).toMatchObject({ runId: expect.any(String) })
  const completedEvent = await waitForBashEvent(page, sessionId, "bash-complete", "BashFinished")
  expect(completedEvent).toMatchObject({
    execution: {
      id: "bash-complete",
      message: { output: "e2e-bash", cancelled: false, exitCode: 0 },
    },
  })

  const running = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "bash-abort",
    command: "sleep 30",
    excludeFromContext: true,
  })
  expect(running.status).toBe(200)
  await waitForBashEvent(page, sessionId, "bash-abort", "BashStarted")
  const rejected = await mutate(page, `/api/sessions/${sessionId}/actions/compact`, {})
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(409)
  expect(rejected.body).toMatchObject({
    _tag: "Conflict",
    detail: { _tag: "AlreadyRunning", operation: "bash" },
  })
  const aborted = await mutate(page, `/api/sessions/${sessionId}/actions/abort-bash`, {})
  expect(aborted.status).toBe(200)
  const abortedEvent = await waitForBashEvent(page, sessionId, "bash-abort", "BashFinished")
  expect(abortedEvent).toMatchObject({ execution: { message: { cancelled: true } } })

  const removed = await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
  expect(removed.status).toBe(200)
})

test("runs and aborts a second shell operation through the React controller", async ({ page }) => {
  test.setTimeout(30_000)
  const sessionId = "00000000-0000-4000-8000-000000000001"
  let runningStreamRequests = 0
  await page.route("**/api/sessions/running/events", async (route) => {
    runningStreamRequests += 1
    if (runningStreamRequests === 1) await route.abort()
    else await route.continue()
  })
  await page.goto(`/?session=${sessionId}`)
  await expect(page.getByText("seed reply", { exact: true })).toBeVisible()
  await expect.poll(() => runningStreamRequests).toBeGreaterThanOrEqual(2)
  const turnSummary = page.locator("summary").filter({ hasText: "本轮" })
  await expect(turnSummary.getByText("1ms", { exact: true })).toBeVisible()
  await turnSummary.click()
  await expect(page.getByText("最后一次耗时", { exact: true })).toBeVisible()

  const prior = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "prior-api-run",
    command: "printf prior-run",
    excludeFromContext: true,
  })
  expect(prior.status).toBe(200)
  await waitForBashEvent(page, sessionId, "prior-api-run", "BashFinished")

  const input = page.locator("textarea").first()
  await expect(input).toHaveAttribute("placeholder", "输入消息… 使用 / 调用命令，使用 @ 引用文件")
  await input.fill("!sleep 30")
  const bashResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/sessions/${sessionId}/actions/bash`) && response.request().method() === "POST",
  )
  await input.press("Enter")
  const accepted = await bashResponse
  expect(accepted.status(), await accepted.text()).toBe(200)
  await expect(input).toHaveAttribute("placeholder", "Shell 命令正在运行…")
  const stop = page.getByTitle("停止 Shell 命令")
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(page.getByText("已取消").last()).toBeVisible()
  await expect(page.locator(`[data-session-id="${sessionId}"]`).getByLabel("Agent 正在运行")).toHaveCount(0)
})

test("forks the root message with one stable persisted identity", async ({ page }) => {
  await page.goto("/")
  const sessionId = "00000000-0000-4000-8000-000000000001"
  const snapshot = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`)
    return { status: response.status, body: await response.json() }
  }, sessionId)
  expect(snapshot.status).toBe(200)
  const rootEntryId = (
    snapshot.body as {
      context: { messages: Array<{ role: string; content: unknown }>; entryIds: string[] }
    }
  ).context.entryIds[0]
  expect(rootEntryId).toBeTruthy()

  const navigated = await mutate(page, `/api/sessions/${sessionId}/actions/navigate`, {
    targetId: rootEntryId,
  })
  expect(navigated.status, JSON.stringify(navigated.body)).toBe(200)
  expect(navigated.body).toMatchObject({ cancelled: false })

  const forked = await mutate(page, `/api/sessions/${sessionId}/actions/fork`, {
    entryId: rootEntryId,
  })
  expect(forked.status, JSON.stringify(forked.body)).toBe(200)
  expect(forked.body).toMatchObject({ cancelled: false, newSessionId: expect.any(String) })
  const newSessionId = (forked.body as { newSessionId: string }).newSessionId

  const reopened = await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${id}`)
    return { status: response.status, body: await response.json() }
  }, newSessionId)
  expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)
  expect(reopened.body).toMatchObject({
    sessionId: newSessionId,
    info: { id: newSessionId, parentSessionId: sessionId },
    context: { messages: [], entryIds: [] },
  })
})

test("decodes invalid payloads before domain execution", async ({ page }) => {
  await page.goto("/")
  const payload = await mutate(page, "/api/sessions", { cwd: 123 })
  expect(payload.status).toBe(400)

  const query = await page.evaluate(async () => {
    const response = await fetch("/api/sessions/missing/thinking?blockIndex=0")
    return { status: response.status, body: await response.json() }
  })
  expect(query.status).toBe(400)
  expect(query.body).toMatchObject({ _tag: "InvalidInput", field: "query" })
})

test("imports, exports, and validates raw model JSON", async ({ page }) => {
  const modelsPath = resolve("test-results/e2e-fixture/home/.pi/agent/models.json")
  await rm(modelsPath, { force: true })
  await page.goto("/")
  await page.getByRole("button", { name: "模型", exact: true }).click()
  await page.getByRole("button", { name: "Raw JSON", exact: true }).click()

  const editor = page.getByRole("textbox", { name: "模型 Raw JSON" })
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled()
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeDisabled()
  await editor.fill("{}")
  await page.getByRole("button", { name: "校验", exact: true }).click()
  await expect(page.getByText(/providers/).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled()

  const source = '{"providers":{}}'
  await editor.fill(source)
  await page.getByRole("button", { name: "校验", exact: true }).click()
  await expect(page.getByText("配置有效", { exact: true }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeEnabled()

  await page.locator('input[type="file"][accept*="json"]').setInputFiles({
    name: "models.json",
    mimeType: "application/json",
    buffer: Buffer.from(source),
  })
  await expect(page.getByText("已导入并通过校验，保存后生效。", { exact: true })).toBeVisible()

  const downloadPromise = page.waitForEvent("download")
  await page.getByRole("button", { name: "导出", exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("models.json")
})

test("rejects Pi-invalid model configs without replacing the file", async ({ page }) => {
  const modelsPath = resolve("test-results/e2e-fixture/home/.pi/agent/models.json")
  await mkdir(dirname(modelsPath), { recursive: true })
  const baseline = '{"providers":{}}'
  await writeFile(modelsPath, baseline)
  await page.goto("/")

  const invalid = {
    providers: {
      custom: {
        api: "openai-completions",
        models: [{ id: "model-1" }],
      },
    },
  }
  const validation = await mutate(page, "/api/models/config/validate", invalid)
  expect(validation.status).toBe(200)
  expect(validation.body).toMatchObject({ valid: false, error: expect.stringContaining("baseUrl") })

  const save = await mutate(page, "/api/models/config", invalid, "PUT")
  expect(save.status).toBe(500)
  expect(await readFile(modelsPath, "utf8")).toBe(baseline)

  const valid = {
    providers: {
      custom: {
        baseUrl: "https://example.test/v1",
        api: "openai-completions",
        models: [{ id: "model-1" }],
      },
    },
  }
  const validResult = await mutate(page, "/api/models/config/validate", valid)
  expect(validResult).toEqual({ status: 200, body: { valid: true } })
  const saved = await mutate(page, "/api/models/config", valid, "PUT")
  expect(saved).toEqual({ status: 200, body: { ok: true } })
  expect(JSON.parse(await readFile(modelsPath, "utf8"))).toEqual(valid)
  await rm(modelsPath)
})

test("fails closed on a corrupt models config without overwriting it", async ({ request }) => {
  const modelsPath = resolve("test-results/e2e-fixture/home/.pi/agent/models.json")
  await mkdir(dirname(modelsPath), { recursive: true })
  const corrupt = "{not-json\n"
  await writeFile(modelsPath, corrupt)

  const response = await request.get("/api/models/config")
  expect(response.status()).toBe(500)
  expect(await readFile(modelsPath, "utf8")).toBe(corrupt)

  await rm(modelsPath)
  const missing = await request.get("/api/models/config")
  expect(missing.status()).toBe(200)
  await expect(missing.json()).resolves.toEqual({ providers: {} })
})

test("loads model, auth, plugin, and skill projections without mutating user state", async ({ page }) => {
  await page.goto("/")
  await mutate(page, "/api/workspace/cwd/validate", { cwd: fixtureWorkspace })
  const projections = await page.evaluate(async (cwd) => {
    const get = async (url: string) => {
      const response = await fetch(url)
      return { status: response.status, body: await response.json() }
    }
    return {
      models: await get(`/api/models?cwd=${encodeURIComponent(cwd)}`),
      oauth: await get("/api/auth/oauth/providers"),
      apiKeys: await get("/api/auth/api-key/providers"),
      plugins: await get(`/api/packages/plugins?cwd=${encodeURIComponent(cwd)}`),
      skills: await get(`/api/packages/skills?cwd=${encodeURIComponent(cwd)}`),
    }
  }, fixtureWorkspace)
  expect(projections.models.status).toBe(200)
  expect(projections.oauth).toMatchObject({ status: 200, body: { providers: expect.any(Array) } })
  expect(projections.apiKeys).toMatchObject({ status: 200, body: { providers: expect.any(Array) } })
  expect(projections.plugins.status).toBe(200)
  expect(projections.skills.status).toBe(200)

  const skillFile = resolve(fixtureWorkspace, ".agents", "skills", "e2e-skill", "SKILL.md")
  const skillRoundTrip = await page.evaluate(
    async ({ cwd, filePath }) => {
      const toggle = async (disableModelInvocation: boolean) => {
        const response = await fetch("/api/packages/skills", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, filePath, disableModelInvocation }),
        })
        return response.status
      }
      const read = async () =>
        fetch(`/api/workspace/files/read?path=${encodeURIComponent(filePath)}`).then((response) =>
          response.json(),
        ) as Promise<{ content: string }>
      const disabledStatus = await toggle(true)
      const disabled = await read()
      const enabledStatus = await toggle(false)
      const enabled = await read()
      return { disabledStatus, disabled: disabled.content, enabledStatus, enabled: enabled.content }
    },
    { cwd: fixtureWorkspace, filePath: skillFile },
  )
  expect(skillRoundTrip).toMatchObject({ disabledStatus: 200, enabledStatus: 200 })
  expect(skillRoundTrip.disabled).toContain("disable-model-invocation: true")
  expect(skillRoundTrip.enabled).not.toContain("disable-model-invocation")

  const pluginRoundTrip = await page.evaluate(
    async ({ cwd, source }) => {
      const action = async (name: "install" | "remove", actionSource: string) => {
        const response = await fetch("/api/packages/plugins/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, action: name, source: actionSource, scope: "project" }),
        })
        return { status: response.status, body: await response.json() }
      }
      const installed = await action("install", source)
      const configured = installed.body.packages.find(
        (pkg: { packageName?: string; source: string }) => pkg.packageName === "pi-web-e2e-plugin",
      )
      return { installed, removed: await action("remove", configured?.source ?? source) }
    },
    { cwd: fixtureWorkspace, source: fixturePluginDirectory },
  )
  expect(pluginRoundTrip.installed.status, JSON.stringify(pluginRoundTrip.installed.body)).toBe(200)
  expect(pluginRoundTrip.installed.body).toMatchObject({
    packages: expect.arrayContaining([expect.objectContaining({ packageName: "pi-web-e2e-plugin" })]),
  })
  expect(pluginRoundTrip.removed.status, JSON.stringify(pluginRoundTrip.removed.body)).toBe(200)
  expect(pluginRoundTrip.removed.body.packages).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ packageName: "pi-web-e2e-plugin" })]),
  )

  const settings = JSON.parse(await readFile(fixtureSettingsPath, "utf8")) as Record<string, unknown>
  await writeFile(fixtureSettingsPath, JSON.stringify({ ...settings, packages: ["npm:@fixture/uninstalled"] }))
  const npmRemoval = await mutate(page, "/api/packages/plugins/actions", {
    cwd: fixtureWorkspace,
    action: "remove",
    source: "npm:@fixture/uninstalled",
    scope: "global",
  })
  expect(npmRemoval.status).toBe(200)
  await expect(readFile(fixtureNpmCommandLog, "utf8")).rejects.toThrow()

  const authRoundTrip = await page.evaluate(async () => {
    const providersResponse = await fetch("/api/auth/api-key/providers")
    const providers = (await providersResponse.json()) as { providers: Array<{ id: string }> }
    const provider = providers.providers[0]?.id
    if (provider === undefined) return null
    const url = `/api/auth/api-key/${encodeURIComponent(provider)}`
    const set = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "isolated-e2e-key" }),
    })
    const configured = await fetch(url).then((response) => response.json())
    const removed = await fetch(url, { method: "DELETE" })
    const cleared = await fetch(url).then((response) => response.json())
    return { set: set.status, configured, removed: removed.status, cleared }
  })
  expect(authRoundTrip).not.toBeNull()
  expect(authRoundTrip).toMatchObject({
    set: 200,
    configured: { configured: true },
    removed: 200,
    cleared: { configured: false },
  })
})
