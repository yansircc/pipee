import {
  MEDIA_VIEW_CAPABILITY,
  MediaView,
  RUNTIME_RETENTION_CAPABILITY,
  RuntimeRetentionClaim,
  STRUCTURED_VIEW_CAPABILITY,
  StructuredViewDiscriminator,
  type MediaView as MediaViewValue,
  type MediaViewPort,
  type RuntimeRetentionPort,
  type StructuredView as StructuredViewValue,
  type StructuredViewPort,
} from "@pi-suite/companion-contracts/host-capabilities";
import { Schema } from "effect";

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
}

const decodeStructuredView = Schema.decodeUnknownSync(StructuredViewDiscriminator);
const decodeMediaView = Schema.decodeUnknownSync(MediaView);
const decodeRetentionClaim = Schema.decodeUnknownSync(RuntimeRetentionClaim);
const decodeName = Schema.decodeUnknownSync(Schema.NonEmptyString);

const assertName = (value: string): string => decodeName(value.trim());

export const capabilitySlotKey = (ownerId: string, slot: string): string =>
  JSON.stringify([ownerId, slot]);

export const makeExtensionHostCapabilities = (callbacks: ExtensionCapabilityCallbacks) => {
  const retention = new Map<string, symbol>();

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

  return {
    providers: new Map<string, HostCapabilityProvider>([
      [STRUCTURED_VIEW_CAPABILITY, structuredProvider],
      [MEDIA_VIEW_CAPABILITY, mediaProvider],
      [RUNTIME_RETENTION_CAPABILITY, retentionProvider],
    ]),
    hasRetention: () => retention.size > 0,
    dispose: () => retention.clear(),
  };
};
