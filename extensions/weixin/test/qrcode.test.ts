import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import QRCode from "qrcode";
import { QrCodeError } from "../src/errors.ts";

it.effect("web login QR is a square PNG with a quiet zone", () =>
  Effect.gen(function* () {
    const dataUrl = yield* Effect.tryPromise({
      try: () =>
        QRCode.toDataURL("https://example.test/weixin-login", {
          errorCorrectionLevel: "M",
          margin: 4,
          width: 384,
        }),
      catch: (cause) => new QrCodeError({ cause }),
    });
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    expect(png.readUInt32BE(16)).toBe(384);
    expect(png.readUInt32BE(20)).toBe(384);
  }),
);
