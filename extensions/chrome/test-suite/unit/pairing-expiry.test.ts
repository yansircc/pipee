import { expect, it } from "vite-plus/test";
import { formatPairingTimeRemaining } from "../../src/pi/pairing-expiry.js";

it("formats pairing expiry from the actual absolute deadline", () => {
  expect(formatPairingTimeRemaining(120_000, 0)).toBe("2 minutes");
  expect(formatPairingTimeRemaining(120_000, 1_001)).toBe("119 seconds");
  expect(formatPairingTimeRemaining(61_000, 1_000)).toBe("1 minute");
  expect(formatPairingTimeRemaining(1_001, 1)).toBe("1 second");
  expect(formatPairingTimeRemaining(1_000, 2_000)).toBe("0 seconds");
});
