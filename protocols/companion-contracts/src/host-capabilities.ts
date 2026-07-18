import { Schema } from "effect";

export const PI_SUITE_CAPABILITY_METHOD = "getPiSuiteCapability" as const;
export const STRUCTURED_VIEW_CAPABILITY = "pi-suite/structured-view@1" as const;
export const MEDIA_VIEW_CAPABILITY = "pi-suite/media-view@1" as const;
export const RUNTIME_RETENTION_CAPABILITY = "pi-suite/runtime-retention@1" as const;

export const StructuredViewDiscriminator = Schema.Struct({
  kind: Schema.NonEmptyString,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface StructuredView {
  readonly kind: string;
  readonly version: number;
}

export const MediaView = Schema.Struct({
  dataUrl: Schema.String,
  alt: Schema.NonEmptyString,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type MediaView = typeof MediaView.Type;

export const RuntimeRetentionClaim = Schema.Struct({ reason: Schema.NonEmptyString });
export type RuntimeRetentionClaim = typeof RuntimeRetentionClaim.Type;

export interface StructuredViewPort {
  readonly replace: <T extends StructuredView>(slot: string, view?: T) => void;
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
