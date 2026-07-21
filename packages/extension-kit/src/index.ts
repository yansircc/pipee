import {
  MEDIA_VIEW_CAPABILITY,
  PI_SUITE_CAPABILITY_METHOD,
  RUNTIME_RETENTION_CAPABILITY,
  STRUCTURED_VIEW_CAPABILITY,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type MediaViewPort,
  type RuntimeRetentionClaim,
  type RuntimeRetentionPort,
  type StructuredViewPort,
} from "@pipee/companion-contracts/host-capabilities";
import {
  type JsonValue,
  type WebSurfaceDispatch,
  type WebSurfaceRuntimeHandle,
  type WebSurfaceRuntimePort,
} from "@pipee/companion-contracts/web-surface";
import { Data, Effect, Scope } from "effect";

interface HostCapabilityLookup {
  readonly [PI_SUITE_CAPABILITY_METHOD]?: <T = unknown>(
    ownerId: string,
    id: string,
  ) => T | undefined;
}

export type HostCapabilityCarrier = unknown;

const capability = <T>(host: HostCapabilityCarrier, ownerId: string, id: string): T | undefined =>
  (host as HostCapabilityLookup | undefined)?.[PI_SUITE_CAPABILITY_METHOD]?.<T>(ownerId, id);

export const structuredView = (
  host: HostCapabilityCarrier,
  ownerId: string,
): StructuredViewPort | undefined =>
  capability<StructuredViewPort>(host, ownerId, STRUCTURED_VIEW_CAPABILITY);

export const mediaView = (
  host: HostCapabilityCarrier,
  ownerId: string,
): MediaViewPort | undefined => capability<MediaViewPort>(host, ownerId, MEDIA_VIEW_CAPABILITY);

export class WebSurfaceCapabilityUnavailable extends Data.TaggedError(
  "WebSurfaceCapabilityUnavailable",
)<{
  readonly ownerId: string;
}> {}

export interface WebSurfaceSlot {
  readonly replace: (view?: JsonValue) => void;
}

export const webSurface = (
  host: HostCapabilityCarrier,
  ownerId: string,
  dispatch: WebSurfaceDispatch,
): Effect.Effect<WebSurfaceSlot, WebSurfaceCapabilityUnavailable, Scope.Scope> => {
  const port = capability<WebSurfaceRuntimePort>(host, ownerId, WEB_SURFACE_RUNTIME_CAPABILITY);
  if (port === undefined) return Effect.fail(new WebSurfaceCapabilityUnavailable({ ownerId }));
  return Effect.acquireRelease(
    Effect.sync(() => port.register({ dispatch })),
    (handle: WebSurfaceRuntimeHandle) => Effect.sync(() => handle.release()),
  ).pipe(Effect.map((handle) => ({ replace: handle.replace })));
};

export const retainRuntime = (
  host: HostCapabilityCarrier,
  ownerId: string,
  slot: string,
  claim: RuntimeRetentionClaim,
): Effect.Effect<void, never, Scope.Scope> => {
  const port = capability<RuntimeRetentionPort>(host, ownerId, RUNTIME_RETENTION_CAPABILITY);
  if (port === undefined) return Effect.void;
  return Effect.acquireRelease(
    Effect.sync(() => port.acquire(slot, claim)),
    (handle) => Effect.sync(() => handle.release()),
  ).pipe(Effect.asVoid);
};

export interface RuntimeRetentionSlot {
  readonly replace: (claim?: RuntimeRetentionClaim) => void;
}

export const makeRuntimeRetentionSlot = (
  host: HostCapabilityCarrier,
  ownerId: string,
  slot: string,
): Effect.Effect<RuntimeRetentionSlot, never, Scope.Scope> =>
  Effect.gen(function* () {
    const port = capability<RuntimeRetentionPort>(host, ownerId, RUNTIME_RETENTION_CAPABILITY);
    let current: { readonly reason: string; readonly release: () => void } | undefined;
    let closed = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        current?.release();
        current = undefined;
      }),
    );
    return {
      replace: (claim) => {
        if (closed) return;
        if (claim?.reason === current?.reason) return;
        current?.release();
        current =
          claim === undefined || port === undefined
            ? undefined
            : { ...claim, ...port.acquire(slot, claim) };
      },
    };
  });
