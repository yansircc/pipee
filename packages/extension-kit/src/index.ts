import {
  MEDIA_VIEW_CAPABILITY,
  PIPEE_CAPABILITY_METHOD,
  RUNTIME_RETENTION_CAPABILITY,
  LIVE_PRESENTATION_CAPABILITY,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type MediaViewPort,
  type RuntimeRetentionClaim,
  type RuntimeRetentionPort,
  type LivePresentationPort,
} from "@pipee/companion-contracts/host-capabilities";
import {
  type JsonValue,
  type WebSurfaceDispatch,
  type WebSurfaceRuntimeHandle,
  type WebSurfaceRuntimePort,
} from "@pipee/companion-contracts/web-surface";
import {
  PRESENTATION_DETAILS_KEY,
  PresentationDocument as PresentationDocumentSchema,
  type PresentationDocument,
} from "@pipee/companion-contracts/presentation";
import { Data, Effect, Schema, Scope } from "effect";

interface HostCapabilityLookup {
  readonly [PIPEE_CAPABILITY_METHOD]?: <T = unknown>(ownerId: string, id: string) => T | undefined;
}

export type HostCapabilityCarrier = unknown;

const capability = <T>(host: HostCapabilityCarrier, ownerId: string, id: string): T | undefined =>
  (host as HostCapabilityLookup | undefined)?.[PIPEE_CAPABILITY_METHOD]?.<T>(ownerId, id);

const decodePresentationDocument = Schema.decodeUnknownSync(PresentationDocumentSchema);

export const withPresentation = <Details extends Readonly<Record<string, unknown>>>(
  details: Details,
  document: PresentationDocument,
): Details & { readonly [PRESENTATION_DETAILS_KEY]: PresentationDocument } => ({
  ...details,
  [PRESENTATION_DETAILS_KEY]: decodePresentationDocument(document),
});

export const livePresentation = (
  host: HostCapabilityCarrier,
  ownerId: string,
): LivePresentationPort | undefined =>
  capability<LivePresentationPort>(host, ownerId, LIVE_PRESENTATION_CAPABILITY);

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
