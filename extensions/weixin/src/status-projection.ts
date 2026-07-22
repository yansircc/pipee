import { Schema } from "effect";

export const WeixinStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-weixin/status"),
  version: Schema.Literal(3),
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  phase: Schema.Literals([
    "Stopped",
    "Connecting",
    "Connected",
    "Retrying",
    "ReauthenticationRequired",
  ]),
  sendReady: Schema.Boolean,
  accountId: Schema.optionalKey(Schema.String),
  defaultSessionId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export type WeixinStatusProjection = typeof WeixinStatusProjection.Type;
