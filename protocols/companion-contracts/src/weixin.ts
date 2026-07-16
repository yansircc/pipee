import { Schema } from "effect"

export const WeixinBindingStatus = Schema.Struct({
  sessionId: Schema.String,
  accountId: Schema.optionalKey(Schema.String),
  connected: Schema.Boolean,
  phase: Schema.Literals([
    "Stopped",
    "Connecting",
    "Connected",
    "Retrying",
    "ReauthenticationRequired",
  ]),
  error: Schema.optionalKey(Schema.String),
})
export type WeixinBindingStatus = typeof WeixinBindingStatus.Type

const WeixinBindings = Schema.Array(WeixinBindingStatus).check(
  Schema.makeFilter(
    (bindings) => new Set(bindings.map((binding) => binding.sessionId)).size === bindings.length,
    { message: "Each session can have at most one Weixin binding" },
  ),
  Schema.makeFilter(
    (bindings) => {
      const accountIds = bindings.flatMap((binding) =>
        binding.accountId === undefined ? [] : [binding.accountId],
      )
      return new Set(accountIds).size === accountIds.length
    },
    { message: "Each Weixin account can bind to at most one session" },
  ),
)

export const WeixinStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-weixin/status"),
  version: Schema.Literal(2),
  bindings: WeixinBindings,
})
export type WeixinStatusProjection = typeof WeixinStatusProjection.Type

export const WeixinControlRequest = Schema.Struct({
  action: Schema.Union([
    Schema.TaggedStruct("Login", {}),
    Schema.TaggedStruct("Bind", {}),
    Schema.TaggedStruct("Start", {}),
    Schema.TaggedStruct("Stop", {}),
    Schema.TaggedStruct("Status", {}),
    Schema.TaggedStruct("Logout", {}),
  ]),
})
export type WeixinControlRequest = typeof WeixinControlRequest.Type
