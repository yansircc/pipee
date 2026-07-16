import { expect, it } from "vite-plus/test";
import { decodeExternalWebRun } from "../../src/browser/external-web-run.js";

it("accepts every explicit loopback port and preserves the origin", () => {
  expect(
    decodeExternalWebRun(
      { version: 1, type: "pi-chrome/web-run/status" },
      "http://127.0.0.1:43729/session",
    ),
  ).toEqual({
    webOrigin: "http://127.0.0.1:43729",
    request: { version: 1, type: "pi-chrome/web-run/status" },
  });
  expect(
    decodeExternalWebRun(
      { version: 1, type: "pi-chrome/web-run/prepare" },
      "http://localhost:65535/",
    ),
  ).toEqual({
    webOrigin: "http://localhost:65535",
    request: { version: 1, type: "pi-chrome/web-run/prepare" },
  });
});

it.each([
  [{ version: 1, type: "pi-chrome/web-run/status", extra: true }, "http://127.0.0.1:30141/"],
  [{ version: 1, type: "pi-chrome/web-run/complete", pairingId: "" }, "http://127.0.0.1:30141/"],
  [{ version: 2, type: "pi-chrome/web-run/status" }, "http://127.0.0.1:30141/"],
  [{ version: 1, type: "pi-chrome/web-run/unknown" }, "http://127.0.0.1:30141/"],
  [{ version: 1, type: "pi-chrome/web-run/status" }, "http://127.0.0.1/"],
  [{ version: 1, type: "pi-chrome/web-run/status" }, "https://127.0.0.1:30141/"],
  [{ version: 1, type: "pi-chrome/web-run/status" }, "http://192.168.1.2:30141/"],
])(
  "rejects malformed, excess, and non-explicit-loopback external messages",
  (message, senderUrl) => {
    expect(decodeExternalWebRun(message, senderUrl)).toBeNull();
  },
);
