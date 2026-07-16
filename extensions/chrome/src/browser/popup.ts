import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { messageOf } from "../core/errors.js";
import { decodePairingConfirmResponseJson } from "../protocol/codec.js";
import { pairingRequest } from "./connector-http.js";
import { requestConnectorIdentity } from "./connector-identity-message.js";

const identity = document.querySelector<HTMLParagraphElement>("#identity")!;
const label = document.querySelector<HTMLInputElement>("#label")!;
const panel = document.querySelector<HTMLElement>("#challenge-panel")!;
const challenge = document.querySelector<HTMLInputElement>("#challenge")!;
const message = document.querySelector<HTMLParagraphElement>("#message")!;
const confirm = document.querySelector<HTMLButtonElement>("#confirm")!;
const PAIRING_CAPABILITY_RE = /^[A-F0-9]{32}$/;
const effectRuntime = ManagedRuntime.make(Layer.empty);

const renderMessage = (text: string, level: "info" | "error" | "success" = "info") =>
  Effect.sync(() => {
    message.textContent = text;
    message.dataset.level = level;
  });

const refresh = Effect.gen(function* () {
  const connector = yield* requestConnectorIdentity({ type: "pi-chrome/connector/load" });
  yield* Effect.sync(() => {
    identity.textContent = `Connector ${connector.connectorId.slice(0, 8)} · v${connector.extensionDisplayVersion}`;
    label.value = connector.label;
    panel.hidden = false;
    confirm.disabled = false;
  });
  yield* renderMessage("Run /chrome onboard in Pi, then paste its one-time token here.");
});

const pair = Effect.gen(function* () {
  const capability = challenge.value.trim().toUpperCase();
  if (!PAIRING_CAPABILITY_RE.test(capability)) {
    return yield* renderMessage("Enter the 32-character token shown by Pi.", "error");
  }
  yield* Effect.sync(() => {
    confirm.disabled = true;
  });
  const connector = yield* requestConnectorIdentity({
    type: "pi-chrome/connector/rename",
    label: label.value,
  });
  const result = yield* pairingRequest(
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connector }),
    },
    connector,
    capability,
  );
  const response = yield* decodePairingConfirmResponseJson(result.text);
  if (response.ok === false) return yield* renderMessage(response.error, "error");
  yield* Effect.sync(() => {
    challenge.value = "";
    panel.hidden = true;
  });
  yield* renderMessage(`Paired ${response.connector.label}.`, "success");
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      if (!panel.hidden) confirm.disabled = false;
    }),
  ),
);

const launch = <A, E>(effect: Effect.Effect<A, E>): void => {
  effectRuntime.runCallback(
    effect.pipe(Effect.catch((error) => renderMessage(messageOf(error), "error"))),
    { onExit: () => undefined },
  );
};

confirm.addEventListener("click", () => launch(pair));
launch(refresh);
