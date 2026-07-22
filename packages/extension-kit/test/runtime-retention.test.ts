import { expect, it } from "@effect/vitest";
import {
  RUNTIME_RETENTION_CAPABILITY,
  LIVE_PRESENTATION_CAPABILITY,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type LivePresentationPort,
  type RuntimeRetentionPort,
} from "@pipee/companion-contracts/host-capabilities";
import { Effect } from "effect";
import {
  makeRuntimeRetentionSlot,
  livePresentation,
  type HostCapabilityCarrier,
  type RuntimeRetentionSlot,
  webSurface,
  WebSurfaceCapabilityUnavailable,
  withPresentation,
} from "../src/index.js";
import type { WebSurfaceRuntimePort } from "@pipee/companion-contracts/web-surface";

it("attaches one validated presentation to existing message details", () => {
  const details = withPresentation(
    { status: "ready" },
    {
      contract: "pipee/presentation@1",
      title: "Fixture",
      summary: "Connected",
      tone: "success",
      icon: "extension",
      body: { type: "badge", text: "Ready", tone: "success" },
    },
  );
  expect(details).toEqual({
    status: "ready",
    pipeePresentation: {
      contract: "pipee/presentation@1",
      title: "Fixture",
      summary: "Connected",
      tone: "success",
      icon: "extension",
      body: { type: "badge", text: "Ready", tone: "success" },
    },
  });
  expect(() =>
    withPresentation(
      {},
      {
        contract: "pipee/presentation@1",
        title: "",
        summary: "Invalid",
        tone: "info",
        icon: "extension",
        body: { type: "progress", value: 2 },
      },
    ),
  ).toThrow();
  expect(() =>
    withPresentation(
      {},
      {
        contract: "pipee/presentation@1",
        title: "Oversized",
        summary: "Too many nodes",
        tone: "info",
        icon: "extension",
        body: {
          type: "group",
          direction: "column",
          gap: "small",
          children: Array.from({ length: 65 }, () => ({
            type: "text" as const,
            text: "node",
            variant: "body" as const,
          })),
        },
      },
    ),
  ).toThrow();
});

it("returns undefined when the host does not provide Pipee capabilities", () => {
  expect(livePresentation({}, "alpha")).toBeUndefined();
});

it("looks up the explicit live presentation capability", () => {
  const port: LivePresentationPort = { replace: () => undefined };
  const host: HostCapabilityCarrier = {
    getPipeeCapability: <T>(_ownerId: string, id: string) =>
      (id === LIVE_PRESENTATION_CAPABILITY ? port : undefined) as T | undefined,
  };
  expect(livePresentation(host, "alpha")).toBe(port);
});

it.effect("releases the current runtime claim when its Effect scope closes", () =>
  Effect.gen(function* () {
    let retained = false;
    let slot: RuntimeRetentionSlot | undefined;
    const port: RuntimeRetentionPort = {
      acquire: () => {
        retained = true;
        return { release: () => (retained = false) };
      },
    };
    const host: HostCapabilityCarrier = {
      getPipeeCapability: <T>(_ownerId: string, id: string) =>
        (id === RUNTIME_RETENTION_CAPABILITY ? port : undefined) as T | undefined,
    };

    yield* Effect.scoped(
      Effect.gen(function* () {
        const active = yield* makeRuntimeRetentionSlot(host, "alpha", "runtime");
        slot = active;
        yield* Effect.sync(() => active.replace({ reason: "running" }));
        expect(retained).toBe(true);
      }),
    );
    expect(retained).toBe(false);
    slot!.replace({ reason: "stale" });
    expect(retained).toBe(false);
  }),
);

it.effect("fails closed without a web surface port and releases the registration with Scope", () =>
  Effect.gen(function* () {
    const missing = yield* Effect.scoped(
      webSurface({}, "alpha", () => ({ _tag: "Accepted", payload: null })),
    ).pipe(Effect.flip);
    expect(missing).toBeInstanceOf(WebSurfaceCapabilityUnavailable);
    let releases = 0;
    const port: WebSurfaceRuntimePort = {
      register: () => ({
        replace: () => undefined,
        release: () => {
          releases += 1;
        },
      }),
    };
    const host: HostCapabilityCarrier = {
      getPipeeCapability: <T>(_ownerId: string, id: string) =>
        (id === WEB_SURFACE_RUNTIME_CAPABILITY ? port : undefined) as T | undefined,
    };
    yield* Effect.scoped(webSurface(host, "alpha", () => ({ _tag: "Accepted", payload: null })));
    expect(releases).toBe(1);
  }),
);
