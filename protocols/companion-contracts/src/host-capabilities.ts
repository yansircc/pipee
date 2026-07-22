import { Schema } from "effect";

export const PIPEE_CAPABILITY_METHOD = "getPipeeCapability" as const;
export const LIVE_PRESENTATION_CAPABILITY = "pipee/live-presentation@1" as const;
export const MEDIA_VIEW_CAPABILITY = "pipee/media-view@2" as const;
export const RUNTIME_RETENTION_CAPABILITY = "pipee/runtime-retention@2" as const;
export const WEB_SURFACE_RUNTIME_CAPABILITY = "pipee/web-surface-runtime@2" as const;

export const MediaView = Schema.Struct({
  dataUrl: Schema.String,
  alt: Schema.NonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type MediaView = typeof MediaView.Type;

export const RuntimeRetentionClaim = Schema.Struct({ reason: Schema.NonEmptyString });
export type RuntimeRetentionClaim = typeof RuntimeRetentionClaim.Type;

export interface LivePresentationPort {
  readonly replace: (
    slot: string,
    document?: import("./presentation.js").PresentationDocument,
  ) => void;
}

export interface MediaViewPort {
  readonly replace: (slot: string, view?: MediaView) => void;
}

export interface RuntimeRetentionHandle {
  readonly release: () => void;
}

export interface RuntimeRetentionPort {
  readonly acquire: (slot: string, claim: RuntimeRetentionClaim) => RuntimeRetentionHandle;
}
