import { expect, test } from "vite-plus/test"
import { countdownText, intervalParts } from "./SessionAutomationBar"

test("formats canonical automation intervals without losing precision", () => {
  expect(intervalParts(30_000)).toEqual({ amount: 30, unit: "s" })
  expect(intervalParts(10 * 60_000)).toEqual({ amount: 10, unit: "m" })
  expect(intervalParts(2 * 3_600_000)).toEqual({ amount: 2, unit: "h" })
  expect(intervalParts(86_400_000)).toEqual({ amount: 1, unit: "d" })
})

test("projects countdown states from server due time and browser clock", () => {
  expect(countdownText(undefined, 1_000, true)).toBe("等待安排")
  expect(countdownText(1_000, 1_000, true)).toBe("等待执行")
  expect(countdownText(62_000, 1_000, true)).toBe("1m 1s")
  expect(countdownText(3_662_000, 1_000, false)).toBe("1h 1m")
})
