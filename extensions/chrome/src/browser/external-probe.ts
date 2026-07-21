import {
  CHROME_EXTENSION_PROBE_KIND,
  isChromeExtensionProbeRequest,
  type ChromeExtensionProbeResponse,
} from "@pipee/companion-contracts/chrome";

export interface ChromeExtensionProbeRuntime {
  readonly id: string;
  readonly getManifest: () => { readonly version: string };
}

export const handleChromeExtensionProbe = (
  message: unknown,
  runtime: ChromeExtensionProbeRuntime,
  protocolFingerprint: string,
): ChromeExtensionProbeResponse | undefined =>
  isChromeExtensionProbeRequest(message)
    ? {
        kind: CHROME_EXTENSION_PROBE_KIND,
        version: 2,
        extension: {
          extensionId: runtime.id,
          displayVersion: runtime.getManifest().version,
          protocolFingerprint,
        },
      }
    : undefined;
