import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { messageOf } from "../core/errors.js";
import { requestConnectorIdentity } from "./connector-identity-message.js";

const identity = document.querySelector<HTMLParagraphElement>("#identity")!;
const state = document.querySelector<HTMLParagraphElement>("#state")!;
const effectRuntime = ManagedRuntime.make(Layer.empty);

const render = Effect.gen(function* () {
  const connector = yield* requestConnectorIdentity({ type: "pi-chrome/connector/load" });
  yield* Effect.sync(() => {
    identity.textContent = `${connector.label} · ${connector.connectorId.slice(0, 8)} · v${connector.extensionDisplayVersion}`;
    state.textContent =
      "Connects to the local Pi bridge automatically while this Chrome profile is open.";
    state.dataset.level = "success";
  });
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      state.textContent = messageOf(error);
      state.dataset.level = "error";
    }),
  ),
);

effectRuntime.runCallback(render, { onExit: () => undefined });
