import {
  MEDIA_VIEW_CAPABILITY,
  MediaView,
  RUNTIME_RETENTION_CAPABILITY,
  RuntimeRetentionClaim,
  STRUCTURED_VIEW_CAPABILITY,
  StructuredViewDiscriminator,
  WEB_SURFACE_RUNTIME_CAPABILITY,
  type MediaView as MediaViewValue,
  type MediaViewPort,
  type RuntimeRetentionPort,
  type StructuredView as StructuredViewValue,
  type StructuredViewPort,
} from "@pipee/companion-contracts/host-capabilities";
import {
  WebSurfaceActionOutcome,
  JsonValue as JsonValueSchema,
  type CandidateHash,
  type JsonValue,
  type WebSurfaceActionRequest,
  type WebSurfaceProjection,
  type WebSurfaceRegistration,
  type WebSurfaceRuntimeHandle,
  type WebSurfaceRuntimePort,
} from "@pipee/companion-contracts/web-surface";
import { Data, Effect, Schema } from "effect";

export class WebSurfaceRegistrationError extends Data.TaggedError("WebSurfaceRegistrationError")<{
  readonly message: string;
}> {}

class WebSurfaceDispatchError extends Data.TaggedError("WebSurfaceDispatchError")<{
  readonly message: string;
}> {}

export interface HostCapabilityProvider {
  readonly forExtension: (ownerId: string) => unknown;
}

export interface ExtensionCapabilityCallbacks {
  readonly replaceStructuredView: (
    ownerId: string,
    slot: string,
    view?: StructuredViewValue,
  ) => void;
  readonly replaceMediaView: (ownerId: string, slot: string, view?: MediaViewValue) => void;
  readonly webSurfaceCandidates?: ReadonlyMap<string, CandidateHash>;
  readonly replaceWebSurface?: (
    ownerId: string,
    projection: WebSurfaceProjection | undefined,
  ) => void;
}

const decodeStructuredView = Schema.decodeUnknownSync(StructuredViewDiscriminator);
const decodeMediaView = Schema.decodeUnknownSync(MediaView);
const decodeRetentionClaim = Schema.decodeUnknownSync(RuntimeRetentionClaim);
const decodeName = Schema.decodeUnknownSync(Schema.NonEmptyString);
const decodeJsonValue = Schema.decodeUnknownSync(JsonValueSchema);
const decodeActionOutcome = Schema.decodeUnknownSync(WebSurfaceActionOutcome);

const assertName = (value: string): string => decodeName(value.trim());
const decodeImpossible = Schema.decodeUnknownSync(Schema.Never);
const failRegistration = (message: string): never =>
  decodeImpossible(new WebSurfaceRegistrationError({ message }));

export const capabilitySlotKey = (ownerId: string, slot: string): string =>
  JSON.stringify([ownerId, slot]);

export const makeExtensionHostCapabilities = (callbacks: ExtensionCapabilityCallbacks) => {
  const retention = new Map<string, symbol>();
  type SurfaceController = {
    readonly candidateHash: CandidateHash;
    readonly registration: WebSurfaceRegistration;
    readonly token: symbol;
    revision: number;
    active: AbortController | undefined;
    released: boolean;
  };
  const surfaces = new Map<string, SurfaceController>();

  const structuredProvider: HostCapabilityProvider = {
    forExtension(ownerId) {
      const owner = assertName(ownerId);
      return {
        replace(slot, view) {
          if (view !== undefined) decodeStructuredView(view);
          callbacks.replaceStructuredView(owner, assertName(slot), view);
        },
      } satisfies StructuredViewPort;
    },
  };

  const mediaProvider: HostCapabilityProvider = {
    forExtension(ownerId) {
      const owner = assertName(ownerId);
      return {
        replace(slot, view) {
          callbacks.replaceMediaView(owner, assertName(slot), view && decodeMediaView(view));
        },
      } satisfies MediaViewPort;
    },
  };

  const retentionProvider: HostCapabilityProvider = {
    forExtension(ownerId) {
      const owner = assertName(ownerId);
      return {
        acquire(slot, claim) {
          const key = capabilitySlotKey(owner, assertName(slot));
          decodeRetentionClaim(claim);
          const token = Symbol(key);
          retention.set(key, token);
          let released = false;
          return {
            release() {
              if (released) return;
              released = true;
              if (retention.get(key) === token) retention.delete(key);
            },
          };
        },
      } satisfies RuntimeRetentionPort;
    },
  };

  const webSurfaceProvider: HostCapabilityProvider = {
    forExtension(ownerId) {
      const owner = assertName(ownerId);
      return {
        register(registration) {
          const candidateHash = callbacks.webSurfaceCandidates?.get(owner);
          if (candidateHash === undefined)
            return failRegistration(`Web surface candidate is not admitted: ${owner}`);
          if (surfaces.has(owner))
            return failRegistration(`Web surface already registered: ${owner}`);
          const token = Symbol(owner);
          const controller: SurfaceController = {
            candidateHash,
            registration,
            token,
            revision: 0,
            active: undefined,
            released: false,
          };
          surfaces.set(owner, controller);
          const replace = (view?: JsonValue) => {
            if (controller.released || surfaces.get(owner)?.token !== token) return;
            if (view !== undefined) decodeJsonValue(view);
            controller.revision += 1;
            callbacks.replaceWebSurface?.(owner, {
              packageName: owner,
              surfaceId: Buffer.from(owner, "utf8").toString(
                "base64url",
              ) as WebSurfaceProjection["surfaceId"],
              candidateHash,
              revision: controller.revision,
              view: view ?? null,
            });
          };
          replace();
          return {
            replace,
            release() {
              if (controller.released) return;
              controller.released = true;
              controller.active?.abort();
              if (surfaces.get(owner)?.token === token) {
                surfaces.delete(owner);
                callbacks.replaceWebSurface?.(owner, undefined);
              }
            },
          } satisfies WebSurfaceRuntimeHandle;
        },
      } satisfies WebSurfaceRuntimePort;
    },
  };

  return {
    providers: new Map<string, HostCapabilityProvider>([
      [STRUCTURED_VIEW_CAPABILITY, structuredProvider],
      [MEDIA_VIEW_CAPABILITY, mediaProvider],
      [RUNTIME_RETENTION_CAPABILITY, retentionProvider],
      [WEB_SURFACE_RUNTIME_CAPABILITY, webSurfaceProvider],
    ]),
    hasRetention: () => retention.size > 0,
    dispatchWebSurface: (
      ownerId: string,
      candidateHash: CandidateHash,
      request: WebSurfaceActionRequest,
    ) =>
      Effect.suspend(() => {
        const controller = surfaces.get(ownerId);
        if (
          controller === undefined ||
          controller.released ||
          controller.candidateHash !== candidateHash
        ) {
          return Effect.succeed(
            WebSurfaceActionOutcome.make({ _tag: "Rejected", reason: "closed" }),
          );
        }
        if (controller.active !== undefined) {
          return Effect.succeed(WebSurfaceActionOutcome.make({ _tag: "Rejected", reason: "busy" }));
        }
        const abort = new AbortController();
        controller.active = abort;
        return Effect.tryPromise({
          try: () => Promise.resolve(controller.registration.dispatch(request, abort.signal)),
          catch: (error) =>
            new WebSurfaceDispatchError({
              message: error instanceof Error ? error.message : String(error),
            }),
        }).pipe(
          Effect.map(decodeActionOutcome),
          Effect.catch((error) =>
            Effect.succeed(
              WebSurfaceActionOutcome.make({
                _tag: "Failed",
                message: error.message,
              }),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (controller.active === abort) controller.active = undefined;
            }),
          ),
        );
      }),
    dispose: () => {
      retention.clear();
      for (const controller of surfaces.values()) {
        controller.released = true;
        controller.active?.abort();
      }
      surfaces.clear();
    },
  };
};
