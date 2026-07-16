import { SCREENSHOT_PAYLOAD_BYTE_LIMIT } from "../protocol/bridge-contract.js";

export const SCREENSHOT_TRANSPORT_BYTE_LIMIT = SCREENSHOT_PAYLOAD_BYTE_LIMIT;

export type ScreenshotTransportBudget =
  | { readonly ok: true; readonly usedBytes: number }
  | { readonly ok: false; readonly usedBytes: number; readonly limitBytes: number };

export const accountScreenshotDataUrl = (
  usedBytes: number,
  dataUrl: string,
): ScreenshotTransportBudget => {
  // CDP screenshot data is base64 ASCII, so string length equals JSON/UTF-8 payload bytes.
  const nextBytes = usedBytes + dataUrl.length;
  if (nextBytes > SCREENSHOT_TRANSPORT_BYTE_LIMIT) {
    return { ok: false, usedBytes: nextBytes, limitBytes: SCREENSHOT_TRANSPORT_BYTE_LIMIT };
  }
  return { ok: true, usedBytes: nextBytes };
};
