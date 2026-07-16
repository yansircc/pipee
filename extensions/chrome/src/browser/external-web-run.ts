import {
  ChromeExternalRequest,
  type ChromeExternalRequest as ChromeExternalRequestType,
} from "@pi-suite/companion-contracts/chrome";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type DecodedExternalWebRun = {
  readonly webOrigin: string;
  readonly request: ChromeExternalRequestType;
};

const decodeRequest = Schema.decodeUnknownOption(ChromeExternalRequest, {
  onExcessProperty: "error",
});

export const decodeExternalWebRun = (
  message: unknown,
  senderUrl: string | undefined,
): DecodedExternalWebRun | null => {
  if (senderUrl === undefined) return null;
  const url = Option.getOrNull(Option.liftThrowable((value: string) => new URL(value))(senderUrl));
  if (url === null) return null;
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }
  const request = Option.getOrNull(decodeRequest(message));
  return request === null ? null : { webOrigin: url.origin, request };
};
