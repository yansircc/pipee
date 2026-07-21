import { expect, test } from "vite-plus/test"
import { countdownText } from "./SessionAutomationBar"

test("projects countdown states from server due time and browser clock", () => {
  expect(countdownText(undefined, 1_000, true)).toBe("等待 Agent 安排")
  expect(countdownText(1_000, 1_000, true)).toBe("等待执行")
  expect(countdownText(62_000, 1_000, true)).toBe("1m 1s")
  expect(countdownText(3_662_000, 1_000, false)).toBe("1h 1m")
})
