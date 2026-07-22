import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import pkg from "../../package.json" with { type: "json" }

const fixtureWorkspace = resolve("test-results/e2e-fixture/workspace")
const fixturePluginDirectory = resolve("test-results/e2e-fixture/e2e-plugin")
const fixtureNpmCommandLog = resolve("test-results/e2e-fixture/npm-command.log")
const fixtureSettingsPath = resolve("test-results/e2e-fixture/home/.pi/agent/settings.json")
const nonGitWorkspace = resolve(tmpdir(), "pipee-e2e-non-git-workspace")

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
    piVersion: "0.80.10",
  })

  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page).toHaveTitle("Pipee")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(page.getByText("Pipee", { exact: true }).first()).toBeVisible({ timeout: 20_000 })
})

test("preserves the normalized visual foundation", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Pipee", { exact: true }).first()).toBeVisible()

  const contract = await page.evaluate(() => {
    const visibleButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.getBoundingClientRect().width > 0,
    )
    const brand = visibleButtons[0]
    const newSession = visibleButtons.find((button) => button.textContent?.includes("新建"))
    const newSessionShortcut = newSession?.querySelector("kbd")
    const settings = visibleButtons.find((button) => button.getAttribute("aria-label") === "设置")
    const sidebar = document.querySelector(".sidebar-container")
    if (
      brand === undefined ||
      newSession === undefined ||
      newSessionShortcut === undefined ||
      newSessionShortcut === null ||
      settings === undefined ||
      sidebar === null
    ) {
      throw new Error("visual contract inventory is incomplete")
    }
    const topbar = sidebar.nextElementSibling?.firstElementChild
    const newSessionRect = newSession.getBoundingClientRect()
    const shortcutRect = newSessionShortcut.getBoundingClientRect()
    return {
      browserDefaultFontLeaks: visibleButtons
        .filter((button) => getComputedStyle(button).fontFamily === "Arial")
        .map((button) => button.textContent),
      newSessionBackground: getComputedStyle(newSession).backgroundColor,
      newSessionShortcutRightInset: newSessionRect.right - shortcutRect.right,
      sidebarWidth: getComputedStyle(sidebar).width,
      topbarHeight: topbar instanceof HTMLElement ? getComputedStyle(topbar).height : null,
    }
  })

  expect(contract.browserDefaultFontLeaks).toEqual([])
  expect(contract.newSessionBackground).not.toBe("rgba(0, 0, 0, 0)")
  expect(contract.newSessionShortcutRightInset).toBeGreaterThanOrEqual(10)
  expect(contract.sidebarWidth).toBe("292px")
  expect(contract.topbarHeight).toBe("58px")
})

test("shows one lightweight Pipee update card with package-manager commands", async ({ page }) => {
  await page.route("**/api/meta/update", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        _tag: "UpdateAvailable",
        checkedAt: Date.now(),
        currentVersion: "0.5.0",
        latestVersion: "0.6.0",
      }),
    }),
  )
  await page.goto("/")

  await page.getByRole("button", { name: "Pipee 有可用更新" }).click()
  const card = page.getByRole("dialog", { name: "更新 Pipee" })
  await expect(card).toContainText("v0.5.0 → v0.6.0")
  await expect(card.getByText("npm install -g @yansircc/pipee@latest", { exact: true })).toBeVisible()

  await card.getByRole("tab", { name: "pnpm" }).click()
  await expect(card.getByText("pnpm add -g @yansircc/pipee@latest", { exact: true })).toBeVisible()
  await card.getByRole("tab", { name: "bun" }).click()
  await expect(card.getByText("bun add -g @yansircc/pipee@latest", { exact: true })).toBeVisible()
})

test("projects application commands into discoverable macOS shortcuts", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" }),
  )
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")

  const commandsTrigger = page.getByRole("button", { name: "命令", exact: true })
  await expect(commandsTrigger).toHaveAttribute("aria-keyshortcuts", "Meta+K")
  await commandsTrigger.click()
  const palette = page.getByRole("dialog", { name: "命令" })
  await expect(palette.getByRole("option")).toHaveCount(7)
  await expect(palette.locator('[data-command-id="session.new"]')).toContainText("⌘⇧O")
  await expect(palette.locator('[data-command-id="composer.focus"]')).toContainText("⇧Esc")
  await expect(palette.locator('[data-command-id="settings.toggle"]')).toContainText("⌘,")

  await palette.getByPlaceholder("搜索命令").fill("设置")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible()
  await page.keyboard.press("Escape")

  const composer = page.locator("textarea").last()
  await composer.fill("draft survives focus")
  await page.getByRole("button", { name: /隐藏侧边栏/ }).focus()
  await page.keyboard.press("Shift+Escape")
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue("draft survives focus")

  const sidebar = page.locator(".sidebar-container")
  await page.keyboard.press("Meta+B")
  await expect(sidebar).toHaveAttribute("aria-hidden", "true")
  await page.keyboard.press("Meta+B")
  await expect(sidebar).toHaveAttribute("aria-hidden", "false")

  await page.keyboard.press("Meta+,")
  await expect(page.getByRole("dialog", { name: "设置" })).toBeVisible()
  await page.keyboard.press("Meta+,")
  await expect(page.getByRole("dialog", { name: "设置" })).toBeHidden()
})

test("matches Control shortcuts and gives Escape one ordered action", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" }),
  )
  const sessionId = "00000000-0000-4000-8000-000000000001"
  let abortRequests = 0
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/sessions/${sessionId}/actions/abort-bash`)) abortRequests += 1
  })
  await page.goto(`/?session=${sessionId}`)

  const commandsTrigger = page.getByRole("button", { name: "命令", exact: true })
  await expect(commandsTrigger).toHaveAttribute("aria-keyshortcuts", "Control+K")
  await commandsTrigger.focus()
  await page.keyboard.press("Control+K")
  const palette = page.getByRole("dialog", { name: "命令" })
  await expect(palette).toBeVisible()
  await expect(palette.locator('[data-command-id="sidebar.toggle"]')).toContainText("Ctrl+B")
  await page.keyboard.press("Escape")
  await expect(palette).toBeHidden()

  const running = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "shortcut-cancellation",
    command: "sleep 10",
    excludeFromContext: true,
  })
  expect(running.status).toBe(200)
  const stop = page.getByRole("button", { name: /停止/ }).last()
  await expect(stop).toBeVisible()

  await page.keyboard.press("Control+K")
  await page.keyboard.press("Escape")
  await expect(palette).toBeHidden()
  expect(abortRequests).toBe(0)

  const composer = page.locator("textarea").last()
  await composer.evaluate((element) => {
    element.addEventListener("keydown", (event) => event.preventDefault(), { once: true })
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }))
  })
  expect(abortRequests).toBe(0)
  await composer.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, isComposing: true, key: "Escape" }),
    )
  })
  expect(abortRequests).toBe(0)

  await page.keyboard.press("Escape")
  await expect.poll(() => abortRequests).toBe(1)
  await expect(stop).toBeHidden()
})

test("gates duplicate new-session shortcuts and exposes disabled commands", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" }),
  )
  await page.goto("/")
  const commandsTrigger = page.getByRole("button", { name: "命令", exact: true })
  await commandsTrigger.click()
  const palette = page.getByRole("dialog", { name: "命令" })
  const focusComposer = palette.locator('[data-command-id="composer.focus"]')
  await expect(focusComposer).toBeDisabled()
  await expect(focusComposer).toContainText("请先打开会话")
  await page.keyboard.press("Escape")

  let createRequests = 0
  let releaseCreate!: () => void
  const createBlocked = new Promise<void>((resolve) => {
    releaseCreate = resolve
  })
  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") {
      createRequests += 1
      await createBlocked
    }
    await route.continue()
  })
  const create = page.getByRole("button", { name: "新建", exact: true })
  await expect(create).toHaveAttribute("aria-keyshortcuts", "Control+Shift+O")
  await expect(create).toBeEnabled()
  await expect(async () => {
    await page.keyboard.press("Control+K")
    await expect(palette).toBeVisible()
  }).toPass()
  await page.keyboard.press("Escape")
  await expect(palette).toBeHidden()
  await create.focus()
  await page.keyboard.press("Control+Shift+O")
  await page.keyboard.press("Control+Shift+O")
  await expect.poll(() => createRequests).toBe(1)
  releaseCreate()
  await expect(page).toHaveURL(/\?session=/)
  const sessionId = new URL(page.url()).searchParams.get("session")
  expect(sessionId).not.toBeNull()
  const removed = await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
  expect(removed.status).toBe(200)
})

test("sizes user bubbles by content up to the responsive maximum", async ({ page }) => {
  const measureBubble = async () =>
    page
      .locator(".markdown-user-message")
      .first()
      .evaluate((message) => {
        const bubble = message.parentElement
        const row = bubble?.parentElement
        const turn = row?.parentElement
        if (!bubble || !turn) throw new Error("user bubble inventory is incomplete")
        return { bubble: bubble.getBoundingClientRect().width, row: turn.getBoundingClientRect().width }
      })

  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
  const short = await measureBubble()
  await page.goto("/?session=00000000-0000-4000-8000-000000000003")
  const long = await measureBubble()

  expect(short.bubble).toBeLessThan(short.row * 0.35)
  expect(long.bubble).toBeGreaterThan(short.bubble)
  expect(long.bubble).toBeLessThanOrEqual(long.row * 0.7)
})

test("projects assistant speech as conversation events and keeps execution details separate", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000005")

  const companionView = page.locator(
    '[data-presentation-contract="pipee/presentation@1"][data-presentation-mode="live"]',
  )
  const firstEvent = page.getByText("I will inspect the workspace first.", { exact: true })
  const finalEvent = page.getByText("The workspace read succeeded; I am preparing the result.", { exact: true })
  const traces = page.locator(".agent-trace-summary")
  await expect(firstEvent).toBeVisible()
  await expect(companionView).toContainText("Fixture companion")
  await expect(companionView).toContainText("Injected by the extension")
  await companionView.getByRole("button").click()
  await expect(companionView).toContainText("Synthetic extension")
  await companionView.getByRole("button").click()
  await expect(traces).toHaveCount(3)
  for (const trace of await traces.all()) await trace.click()
  const readActivity = page.locator('[data-process-kind="tool"][data-tool-name="read"]')
  const extensionView = page.locator('[data-presentation="Fixture Extension"]')
  const thinkingActivities = page.locator('[data-process-kind="thinking"]')
  await expect(readActivity).toBeVisible()
  await expect(extensionView).toContainText("Workspace inspection")
  await expect(extensionView).toContainText("hello.txt")
  await expect(thinkingActivities).toHaveCount(2)
  await expect(finalEvent).toBeVisible()
  const firstAssistantMessage = page.locator("[data-assistant-message]").filter({ has: firstEvent })
  const copyMessage = firstAssistantMessage.getByRole("button", { name: "复制消息" })
  await expect(copyMessage).toHaveCount(1)
  await page.mouse.move(0, 0)
  await expect(copyMessage).toHaveCSS("opacity", "0")
  await expect(copyMessage).toHaveCSS("pointer-events", "none")
  await firstAssistantMessage.hover()
  await expect(copyMessage).toHaveCSS("opacity", "1")
  await expect(copyMessage).toHaveCSS("pointer-events", "auto")
  await expect(copyMessage).toHaveText("")
  const copyGeometry = await firstAssistantMessage.evaluate((message) => {
    const button = message.querySelector<HTMLElement>("[data-message-copy]")
    if (!button) throw new Error("assistant copy action is missing")
    const messageRect = message.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return {
      rightInset: messageRect.right - buttonRect.right,
      topInset: buttonRect.top - messageRect.top,
    }
  })
  expect(copyGeometry).toEqual({ rightInset: 0, topInset: 0 })
  await page.mouse.move(0, 0)
  await copyMessage.focus()
  await expect(copyMessage).toHaveCSS("opacity", "1")
  await expect(page.locator("summary").getByText("6.7 tok/s", { exact: true })).toBeVisible()
  const turnTelemetry = page.locator(".turn-telemetry details summary")
  await expect(turnTelemetry).toHaveCount(1)
  await turnTelemetry.click()
  await expect(page.getByText("本轮用量", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "回到最新消息" })).toHaveCount(0)
  await expect(readActivity.locator("..")).not.toContainText("I will inspect the workspace first.")
  await expect(thinkingActivities.last().locator("..")).not.toContainText(
    "The workspace read succeeded; I am preparing the result.",
  )
  await expect(readActivity.locator("..")).toContainText("read")

  const order = await page.evaluate(() => {
    const byText = (selector: string, text: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim() === text)
    const first = byText("p", "I will inspect the workspace first.")
    const read = document.querySelector<HTMLElement>('[data-process-kind="tool"][data-tool-name="read"]')
    const extensionView = document.querySelector<HTMLElement>('[data-presentation="Fixture Extension"]')
    const thinking = [...document.querySelectorAll<HTMLElement>('[data-process-kind="thinking"]')]
    const final = byText("p", "The workspace read succeeded; I am preparing the result.")
    if (!first || !read || !extensionView || thinking.length !== 2 || !final)
      throw new Error("turn projection is incomplete")
    return {
      thinkingBeforeFirst: Boolean(thinking[0]?.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING),
      firstBeforeRead: Boolean(first.compareDocumentPosition(read) & Node.DOCUMENT_POSITION_FOLLOWING),
      readBeforeView: Boolean(read.compareDocumentPosition(extensionView) & Node.DOCUMENT_POSITION_FOLLOWING),
      viewBeforeThinking: Boolean(
        extensionView.compareDocumentPosition(thinking[1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      thinkingBeforeFinal: Boolean(thinking[1]?.compareDocumentPosition(final) & Node.DOCUMENT_POSITION_FOLLOWING),
    }
  })
  expect(order).toEqual({
    thinkingBeforeFirst: true,
    firstBeforeRead: true,
    readBeforeView: true,
    viewBeforeThinking: true,
    thinkingBeforeFinal: true,
  })
  await expect(page.getByText("Pi", { exact: true })).toHaveCount(0)
  await expect(page.getByText("fixture-model", { exact: true }).first()).toBeVisible()

  const userMessage = await page.evaluate(() => {
    const bubble = document.querySelector<HTMLElement>(".markdown-user-message")?.parentElement
    if (!bubble) throw new Error("user message inventory is incomplete")
    return {
      avatarCount: [...document.querySelectorAll<HTMLElement>("span")].filter((element) => element.textContent === "你")
        .length,
      rightGap: Math.abs(bubble.parentElement!.getBoundingClientRect().right - bubble.getBoundingClientRect().right),
    }
  })
  expect(userMessage).toEqual({ avatarCount: 0, rightGap: 0 })
})

test("opens the session branch catalog and switches by leaf", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")

  const trigger = page.getByRole("button", { name: "分支", exact: true })
  await expect(trigger).toContainText("2 个分支")
  await trigger.click()

  const menu = page.getByRole("menu", { name: "会话分支" })
  await expect(menu).toBeVisible()
  await menu.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  await expect(menu.getByRole("menuitem")).toHaveCount(2)
  await expect(menu.getByRole("menuitem", { name: /当前分支/ })).toHaveAttribute("aria-current", "true")
  const geometry = await page.evaluate(() => {
    const trigger = document.querySelector<HTMLElement>('[aria-label="分支"]')
    const menu = document.querySelector<HTMLElement>('[aria-label="会话分支"]')
    if (!trigger || !menu) throw new Error("branch popup inventory is incomplete")
    const anchor = trigger.getBoundingClientRect()
    const popup = menu.getBoundingClientRect()
    return {
      background: getComputedStyle(menu).backgroundColor,
      gap: popup.top - anchor.bottom,
      leftDelta: Math.abs(popup.left - anchor.left),
      rightOverflow: Math.max(0, popup.right - window.innerWidth),
      width: popup.width,
    }
  })
  expect(geometry).toEqual({
    background: expect.not.stringMatching(/^(?:transparent|rgba\([^)]*,\s*0\))$/),
    gap: 8,
    leftDelta: 0,
    rightOverflow: 0,
    width: 310,
  })

  await menu.getByRole("menuitem", { name: /alternate fixture branch/ }).click()
  await expect(menu).toBeHidden()
  await expect(page.getByText("alternate fixture branch", { exact: true })).toBeVisible()
  await expect(page.getByText("seed reply", { exact: true })).toHaveCount(0)

  await trigger.click()
  await expect(menu).toBeVisible()
  await page.mouse.click(600, 300)
  await expect(menu).toBeHidden()
})

test("aligns every composer utility on one control axis", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")

  const controls = [
    page.getByRole("button", { name: "附加文件", exact: true }),
    page.getByRole("button", { name: "/ 命令", exact: true }),
    page.getByRole("button", { name: "@ 文件", exact: true }),
    page.getByRole("button", { name: "模型", exact: true }),
  ]
  const boxes = await Promise.all(
    controls.map((control) =>
      control.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return { center: rect.top + rect.height / 2, height: rect.height }
      }),
    ),
  )
  expect(boxes.map(({ height }) => height)).toEqual([28, 28, 28, 28])
  expect(
    Math.max(...boxes.map(({ center }) => center)) - Math.min(...boxes.map(({ center }) => center)),
  ).toBeLessThanOrEqual(0.5)
})

test("opens a lightweight two-pane Finder with one highlighted file preview", async ({ page }) => {
  const admittedCwds: string[] = []
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/workspace/cwd/validate")) return
    const body = request.postDataJSON() as { cwd?: string } | null
    if (body?.cwd !== undefined) admittedCwds.push(body.cwd)
  })
  await page.goto("/")
  const primaryModifier = await page.evaluate(() => {
    const platform = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
    return platform.includes("mac") ? "Meta" : "Control"
  })
  const finder = page.getByRole("dialog", { name: "资源管理器" })
  await expect(page.getByRole("button", { name: /资源管理器/ })).toBeVisible()
  await page.keyboard.press(`${primaryModifier}+Shift+E`)
  if (!(await finder.isVisible())) {
    await page.keyboard.press(`${primaryModifier === "Meta" ? "Control" : "Meta"}+Shift+E`)
  }
  await expect(finder).toBeVisible()
  const search = finder.getByRole("textbox", { name: "搜索文件" })
  await expect(search).toBeVisible()
  await expect.poll(() => admittedCwds).toContain(fixtureWorkspace)
  await expect(finder.getByText(fixtureWorkspace, { exact: true })).toBeVisible()
  await expect(finder.getByText("选择文件以预览", { exact: true })).toBeVisible()

  const file = finder.getByRole("button", { name: "hello.txt", exact: true })
  await file.click()
  await expect(file).toHaveAttribute("aria-current", "true")
  await expect(finder).toContainText("hello from the isolated e2e workspace")
  await expect(finder.getByRole("button", { name: "复制", exact: true })).toBeVisible()

  await search.fill("deep-result")
  const deepFile = finder.getByRole("button", { name: "nested/deep-result.ts", exact: true })
  await expect(deepFile).toBeVisible()
  await deepFile.click()
  await expect(finder).toContainText("deepResult")
  await search.fill("")

  await finder.getByRole("button", { name: "long.txt", exact: true }).click()
  await expect(finder).toContainText("line 240")
  const previewScroll = await finder.evaluate((element) => {
    const scrollable = [...element.querySelectorAll<HTMLElement>("*")].find((candidate) => {
      const overflow = getComputedStyle(candidate).overflowY
      return (overflow === "auto" || overflow === "scroll") && candidate.scrollHeight > candidate.clientHeight
    })
    if (scrollable === undefined) return null
    scrollable.scrollTop = 120
    return {
      clientHeight: scrollable.clientHeight,
      scrollHeight: scrollable.scrollHeight,
      scrollTop: scrollable.scrollTop,
    }
  })
  expect(previewScroll).not.toBeNull()
  expect(previewScroll!.scrollHeight).toBeGreaterThan(previewScroll!.clientHeight)
  expect(previewScroll!.scrollTop).toBeGreaterThan(0)

  const layout = await finder.evaluate((element) => {
    const workspace = element.children[1]?.firstElementChild as HTMLElement
    const columns = getComputedStyle(workspace)
      .gridTemplateColumns.split(" ")
      .map((value) => Number.parseFloat(value))
    return { columns, width: element.getBoundingClientRect().width }
  })
  expect(layout.width).toBeLessThanOrEqual(960)
  expect(layout.columns[0]).toBeGreaterThanOrEqual(200)
  expect(layout.columns[0]).toBeLessThanOrEqual(240)

  await page.setViewportSize({ width: 390, height: 780 })
  await expect(finder.getByRole("button", { name: "复制", exact: true })).toBeInViewport()
  await expect(finder.locator('a[download="long.txt"]')).toBeInViewport()

  await page.keyboard.press("Escape")
  await expect(finder).toBeHidden()
})

test("shows immediate metrics, session prompt, and the extension drawer", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")

  const cost = page.getByRole("button", { name: "会话累计", exact: true })
  await expect(cost).toBeVisible()
  await expect(cost).not.toHaveAttribute("title")
  await cost.hover()
  await expect(page.getByRole("tooltip")).toContainText("Cost")

  await page.getByRole("button", { name: "调试信息", exact: true }).click()
  const sessionInspector = page.locator(".session-info-popover")
  await expect(sessionInspector.getByText("Session Inspector", { exact: true })).toBeVisible()
  await expect(sessionInspector.getByRole("button", { name: "复制全部", exact: true })).toBeVisible()
  await expect(sessionInspector.getByText("系统提示词", { exact: true })).toBeVisible()
  await expect(sessionInspector).not.toContainText("发送消息后加载系统提示词")
  expect(await sessionInspector.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(320)
  expect(await sessionInspector.locator("pre").evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  )

  await page.getByRole("button", { name: "插件", exact: true }).click()
  const drawer = page.getByRole("dialog", { name: "插件" })
  await expect(drawer).toBeVisible()
  const viewportWidth = await page.evaluate(() => innerWidth)
  await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().right)).toBe(viewportWidth)
  const geometry = await drawer.evaluate((element) => ({ width: element.getBoundingClientRect().width }))
  expect(geometry.width).toBeLessThanOrEqual(460)
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()

  await page.getByRole("button", { name: "技能", exact: true }).click()
  const skillLibrary = page.getByRole("dialog", { name: "Skill Library" })
  await expect(skillLibrary).toBeVisible()
  await expect(skillLibrary.getByRole("button", { name: /e2e-skill/ })).toHaveCount(0)
  await expect(skillLibrary.getByRole("button", { name: /read-only-skill/ })).toHaveCount(0)
  await skillLibrary.getByRole("button", { name: "关闭", exact: true }).click()

  await page.getByRole("button", { name: "插件", exact: true }).click()
  await page.getByRole("link", { name: /pipee-e2e-extension/ }).click()
  await expect(page).toHaveURL(/\/extensions\//)
  await expect(page.getByText("E2E Surface", { exact: true }).first()).toBeVisible()
})

test("publishes plugin removal through the global toast viewport", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
  const install = await mutate(page, "/api/packages/plugins/actions", {
    action: "install",
    cwd: fixtureWorkspace,
    scope: "project",
    source: fixturePluginDirectory,
  })
  expect(install.status, JSON.stringify(install.body)).toBe(200)
  const installedSource = (install.body as { packages: Array<{ packageName?: string; source: string }> }).packages.find(
    (pkg) => pkg.packageName === "pipee-e2e-plugin",
  )?.source
  expect(installedSource).toBeDefined()
  const source = installedSource ?? fixturePluginDirectory
  const disabled = await mutate(page, "/api/packages/plugins/actions", {
    action: "disable",
    cwd: fixtureWorkspace,
    scope: "project",
    source,
  })
  expect(disabled.status, JSON.stringify(disabled.body)).toBe(200)

  try {
    await page.getByRole("button", { name: "插件", exact: true }).click()
    const drawer = page.getByRole("dialog", { name: "插件" })
    await drawer.getByRole("button", { name: "删除 pipee-e2e-plugin" }).click()
    const toast = page.getByRole("status").filter({ hasText: "拓展已移除。" })
    await expect(toast).toBeVisible()
    expect(await toast.evaluate((element) => element.closest('[role="dialog"]') === null)).toBe(true)
    expect(await toast.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toMatch(
      /^(?:transparent|rgba\([^)]*,\s*0\))$/,
    )
    await expect(toast.getByRole("button", { name: "关闭通知" })).toBeVisible()

    await drawer.getByRole("button", { name: "关闭", exact: true }).click()
    await expect(drawer).toBeHidden()
    await expect(toast).toBeVisible()
  } finally {
    await mutate(page, "/api/packages/plugins/actions", {
      action: "remove",
      cwd: fixtureWorkspace,
      scope: "project",
      source,
    })
  }
})

test("loads a raw-archive Web Surface through the session runtime and opaque iframe", async ({ page, request }) => {
  const browserErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text())
  })
  page.on("pageerror", (error) => browserErrors.push(error.message))
  page.on("requestfailed", (failed) =>
    browserErrors.push(`${failed.url()}: ${failed.failure()?.errorText ?? "failed"}`),
  )
  const sessionId = "00000000-0000-4000-8000-000000000001"
  const catalogResponse = await request.get(`/api/sessions/${sessionId}/web-surfaces`)
  expect(catalogResponse.ok()).toBe(true)
  const catalog = await catalogResponse.json()
  expect(catalog.surfaces).toEqual([
    expect.objectContaining({ packageName: "pipee-e2e-extension", title: "E2E Surface" }),
  ])
  const asset = await request.get(catalog.surfaces[0].documentUrl)
  expect(asset.ok()).toBe(true)
  expect(asset.headers()["content-security-policy"]).toContain("connect-src 'none'")
  expect(asset.headers()["content-security-policy"]).toContain("form-action 'none'")
  expect(asset.headers()["content-security-policy"]).not.toContain("navigate-to")
  expect(asset.headers()["access-control-allow-origin"]).toBe("*")
  const scriptAsset = await request.get(catalog.surfaces[0].documentUrl.replace(/index\.html$/, "app.js"))
  expect(scriptAsset.ok()).toBe(true)
  expect(scriptAsset.headers()["access-control-allow-origin"]).toBe("*")

  await page.goto(`/extensions/${catalog.surfaces[0].surfaceId}`)
  await expect(page).toHaveURL(new RegExp(`/extensions/${catalog.surfaces[0].surfaceId}$`))
  const frame = page.frameLocator('iframe[title="E2E Surface"]')
  await expect(frame.getByText("E2E Surface", { exact: true })).toBeVisible()
  await expect(frame.locator("#isolation"), browserErrors.join("\n")).toHaveText("parent access blocked")
  await expect(frame.locator("#result")).toHaveText("42")
  await page.waitForTimeout(400)
  await page.getByRole("button", { name: "返回主页面" }).click()
  await expect(page.getByText("Pipee", { exact: true }).first()).toBeVisible()
})

test("persists visible locale and theme preferences", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "设置" }).click()
  await page.getByRole("button", { name: "简体中文" }).click()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await page.getByRole("button", { name: "Light", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)

  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.getByRole("button", { name: "Settings" }).click()
  await expect(page.getByRole("button", { name: "English", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Dark", exact: true })).toBeVisible()
})

test("dismisses application settings outside the popover", async ({ page }) => {
  await page.goto("/")
  const opener = page.getByRole("button", { name: "设置" })
  await opener.click()
  const settings = page.getByRole("dialog", { name: "设置" })
  await expect(settings).toBeVisible()
  const geometry = await settings.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { height: rect.height, width: rect.width }
  })
  expect(geometry.width).toBe(250)
  expect(geometry.height).toBeLessThanOrEqual(170)
  await page.locator("main").click({ position: { x: 10, y: 100 } })
  await expect(settings).toBeHidden()
  await expect(opener).toHaveAttribute("aria-expanded", "false")
})

test("keeps runtime and CSS responsive state aligned at 760 and 761 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 761, height: 720 })
  await page.goto("/")
  const sidebar = page.locator(".sidebar-container")
  await expect(sidebar).toHaveCSS("position", "relative")
  await expect(sidebar).toHaveCSS("width", "292px")
  await expect(sidebar).toHaveAttribute("aria-hidden", "false")

  await page.setViewportSize({ width: 760, height: 720 })
  await expect(sidebar).toHaveCSS("position", "fixed")
  await expect(sidebar).toHaveAttribute("aria-hidden", "true")
  await expect(sidebar).toHaveAttribute("inert", "")
})

test("governs settings focus, dismissal, and restoration", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
  const opener = page.getByRole("button", { name: "模型", exact: true })
  const opensConfigDirectly = (await opener.textContent())?.includes("添加模型") ?? false
  await opener.click()
  const dialog = page.getByRole("dialog", { name: "模型" })
  if (!opensConfigDirectly) await page.getByRole("button", { name: "管理模型", exact: true }).click()
  await expect(dialog).toBeVisible()

  await dialog.getByRole("button", { name: "+ 添加提供商", exact: true }).click()
  const providerPicker = page.getByPlaceholder("搜索提供商…")
  await expect(providerPicker).toBeVisible()
  await expect(dialog.getByPlaceholder("搜索提供商…")).toHaveCount(1)
  await page.getByRole("button", { name: /兼容 OpenAI \/ Anthropic/ }).click()
  await expect(providerPicker).toBeHidden()
  await expect(dialog.getByText("提供商", { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press(index === 0 ? "Shift+Tab" : "Tab")
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(opener).toBeVisible()
})

test("keeps ambient project skills outside the closed Pipee skill policy", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 })
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
  await page.getByRole("button", { name: "更多控制项", exact: true }).click()
  await page.getByRole("button", { name: "技能", exact: true }).click()
  const skillWorkspace = page.getByRole("dialog", { name: "Skill Library" })
  await expect(skillWorkspace.getByRole("button", { name: /e2e-skill/ })).toHaveCount(0)
  await expect(skillWorkspace.getByRole("button", { name: /read-only-skill/ })).toHaveCount(0)
  await expect(skillWorkspace.getByRole("switch")).toHaveCount(0)
})

test("canonicalizes an invalid session URL after the session index loads", async ({ page }) => {
  await page.goto("/?session=missing-session")
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByText("Pipee", { exact: true }).first()).toBeVisible()
})

test("renders the root not-found boundary", async ({ page }) => {
  const response = await page.goto("/missing-route")
  expect(response?.status()).toBe(404)
  await expect(page.getByRole("heading", { name: "Not Found" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Pipee" })).toHaveAttribute("href", "/")
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

  const followed = await mutate(page, `/api/sessions/${sessionId}/actions/bash`, {
    id: "followed-scroll-output",
    command: "for i in $(seq 1 40); do printf 'followed-output-%s\\n' \"$i\"; sleep 0.02; done",
    excludeFromContext: true,
  })
  expect(followed.status).toBe(200)
  await waitForBashEvent(page, sessionId, "followed-scroll-output", "BashFinished")
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
    .toBeLessThanOrEqual(2)

  await scroller.hover()
  await page.mouse.wheel(0, -100_000)
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

test("windows deep sessions and preserves the visible anchor while prepending history", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000004")
  const scroller = page.getByTestId("chat-scroll-container")
  await expect(scroller).toBeVisible()
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThanOrEqual(200)

  await scroller.hover()
  await page.mouse.wheel(0, -100_000)
  await expect(page.getByRole("button", { name: "回到最新消息" })).toBeVisible()
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(2)
  const loadEarlier = page.getByRole("button", { name: "Load earlier messages", exact: true })
  await expect(loadEarlier).toBeVisible()
  const anchor = await scroller.evaluate((element) => {
    const viewport = element.getBoundingClientRect()
    const row = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > viewport.top,
    )
    if (!row) throw new Error("visible transcript anchor is missing")
    return { id: row.dataset.transcriptRow!, top: row.getBoundingClientRect().top }
  })
  await loadEarlier.click({ force: true })
  await expect(page.getByRole("button", { name: "Loading…", exact: true })).toHaveCount(0)
  await expect
    .poll(async () => {
      const anchoredTop = await page
        .locator(`[data-transcript-row="${anchor.id}"]`)
        .evaluate((row) => row.getBoundingClientRect().top)
      return Math.abs(anchoredTop - anchor.top)
    })
    .toBeLessThanOrEqual(1)
  expect(await page.locator("[data-transcript-row]").count()).toBeLessThanOrEqual(200)
})

test("projects an active session before Pi persists its first message", async ({ page }) => {
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
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
        textStatuses: expect.arrayContaining([{ key: "e2e-interaction", text: "resolved:2468" }]),
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
        textStatuses: expect.arrayContaining([{ key: "e2e-interaction-queue", text: "alpha:beta" }]),
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
        textStatuses: expect.arrayContaining([{ key: "e2e-interaction-timeout", text: "cancelled" }]),
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
        textStatuses: expect.arrayContaining([{ key: "e2e-interaction-abort", text: "undefined:done" }]),
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
  await expect(page.getByText("/skill:e2e-skill", { exact: true })).toHaveCount(0)

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

test("resolves configured models through the session runtime for creation and switching", async ({ page }) => {
  const modelsPath = resolve("test-results/e2e-fixture/home/.pi/agent/models.json")
  const previousModels = await readFile(modelsPath, "utf8").catch(() => null)
  const previousSettings = await readFile(fixtureSettingsPath, "utf8").catch(() => null)
  await mkdir(dirname(modelsPath), { recursive: true })
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "https://example.test/v1",
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [{ id: "model-a" }, { id: "model-b" }],
        },
      },
    }),
  )
  await page.goto("/")

  let sessionId: string | null = null
  try {
    const created = await mutate(page, "/api/sessions", {
      cwd: fixtureWorkspace,
      model: { provider: "fixture", modelId: "model-a" },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    sessionId = (created.body as { id: string }).id

    const switched = await mutate(page, `/api/sessions/${sessionId}/actions/model`, {
      provider: "fixture",
      modelId: "model-b",
    })
    expect(switched).toEqual({ status: 200, body: { id: "model-b", provider: "fixture" } })

    const snapshot = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}`)
      return { status: response.status, body: await response.json() }
    }, sessionId)
    expect(snapshot).toMatchObject({
      status: 200,
      body: { runtime: { model: { id: "model-b", provider: "fixture" } } },
    })
  } finally {
    if (sessionId !== null) await mutate(page, `/api/sessions/${sessionId}`, {}, "DELETE")
    await page.waitForTimeout(100)
    if (previousModels === null) await rm(modelsPath, { force: true })
    else await writeFile(modelsPath, previousModels)
    if (previousSettings === null) await rm(fixtureSettingsPath, { force: true })
    else await writeFile(fixtureSettingsPath, previousSettings)
  }
})

test("imports, exports, and validates raw model JSON", async ({ page }) => {
  const modelsPath = resolve("test-results/e2e-fixture/home/.pi/agent/models.json")
  await rm(modelsPath, { force: true })
  await page.goto("/?session=00000000-0000-4000-8000-000000000001")
  const opener = page.getByRole("button", { name: "模型", exact: true })
  const opensConfigDirectly = (await opener.textContent())?.includes("添加模型") ?? false
  await opener.click()
  if (!opensConfigDirectly) await page.getByRole("button", { name: "管理模型", exact: true }).click()
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
  expect(projections.skills.body.skills).toEqual([])

  const skillFile = resolve(fixtureWorkspace, ".agents", "skills", "e2e-skill", "SKILL.md")
  const skillBrowse = await page.evaluate(
    async ({ cwd, skillPath }) => {
      const query = new URLSearchParams({ cwd, skillPath })
      const filesResponse = await fetch(`/api/packages/skills/files?${query}`)
      const files = await filesResponse.json()
      const fileQuery = new URLSearchParams({ cwd, skillPath, path: "references/guide.md" })
      const fileResponse = await fetch(`/api/packages/skills/file?${fileQuery}`)
      const file = await fileResponse.json()
      const escapeQuery = new URLSearchParams({ cwd, skillPath, path: "../hello.txt" })
      const escapeResponse = await fetch(`/api/packages/skills/file?${escapeQuery}`)
      return {
        files: { status: filesResponse.status, body: files },
        file: { status: fileResponse.status, body: file },
        escapeStatus: escapeResponse.status,
      }
    },
    { cwd: fixtureWorkspace, skillPath: skillFile },
  )
  expect(skillBrowse.files.status).toBe(403)
  expect(skillBrowse.file.status).toBe(403)
  expect(skillBrowse.escapeStatus).not.toBe(200)
  const beforeSkill = await readFile(skillFile, "utf8")
  const ambientSkillMutation = await mutate(
    page,
    "/api/packages/skills",
    { cwd: fixtureWorkspace, filePath: skillFile, disableModelInvocation: true },
    "PATCH",
  )
  expect(ambientSkillMutation.status).toBe(403)
  expect(await readFile(skillFile, "utf8")).toBe(beforeSkill)
  const deletedSkill = await mutate(
    page,
    "/api/packages/skills",
    { cwd: fixtureWorkspace, filePath: skillFile },
    "DELETE",
  )
  expect(deletedSkill.status).toBe(403)
  expect(await readFile(skillFile, "utf8")).toBe(beforeSkill)

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
      const overviewResponse = await fetch("/api/packages/plugins/overview")
      const overview = { status: overviewResponse.status, body: await overviewResponse.json() }
      const configured = installed.body.packages.find(
        (pkg: { packageName?: string; source: string }) => pkg.packageName === "pipee-e2e-plugin",
      )
      return { installed, overview, removed: await action("remove", configured?.source ?? source) }
    },
    { cwd: fixtureWorkspace, source: fixturePluginDirectory },
  )
  expect(pluginRoundTrip.installed.status, JSON.stringify(pluginRoundTrip.installed.body)).toBe(200)
  expect(pluginRoundTrip.installed.body).toMatchObject({
    packages: expect.arrayContaining([expect.objectContaining({ packageName: "pipee-e2e-plugin" })]),
  })
  expect(pluginRoundTrip.overview).toMatchObject({
    status: 200,
    body: {
      packages: expect.arrayContaining([
        expect.objectContaining({
          packageName: "pipee-e2e-plugin",
          scope: "project",
          ownerCwd: fixtureWorkspace,
        }),
      ]),
    },
  })
  expect(pluginRoundTrip.removed.status, JSON.stringify(pluginRoundTrip.removed.body)).toBe(200)
  expect(pluginRoundTrip.removed.body.packages).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ packageName: "pipee-e2e-plugin" })]),
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
