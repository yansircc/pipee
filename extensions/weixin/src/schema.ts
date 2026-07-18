import { Schema } from "effect";
import { IlinkImageSchema } from "./ilink-protocol.ts";

const WeixinAuthSchema = Schema.Struct({
  token: Schema.String,
  baseUrl: Schema.String,
  accountId: Schema.String,
  userId: Schema.String,
  savedAt: Schema.String,
});
export type WeixinAuth = Schema.Schema.Type<typeof WeixinAuthSchema>;

export const SessionTargetSchema = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.optional(Schema.String),
  cwd: Schema.String,
});
export type SessionTarget = Schema.Schema.Type<typeof SessionTargetSchema>;

const PendingImageBatchBase = {
  sessionId: Schema.String,
  userId: Schema.String,
  messageIds: Schema.Array(Schema.String),
  images: Schema.Array(IlinkImageSchema),
  contextToken: Schema.String,
};

const PendingImageBatchSchema = Schema.Union([
  Schema.TaggedStruct("Collecting", {
    ...PendingImageBatchBase,
    deadlineAt: Schema.Finite,
  }),
  Schema.TaggedStruct("Dispatching", {
    ...PendingImageBatchBase,
    requestId: Schema.String,
    prompt: Schema.String,
  }),
]);
export type PendingImageBatch = Schema.Schema.Type<typeof PendingImageBatchSchema>;

export const BridgeStateSchema = Schema.Struct({
  version: Schema.Literal(3),
  enabled: Schema.Boolean,
  cursor: Schema.String,
  processedMessageIds: Schema.Array(Schema.String),
  pendingImageBatch: Schema.optional(PendingImageBatchSchema),
  auth: Schema.optional(WeixinAuthSchema),
  defaultSession: Schema.optional(SessionTargetSchema),
  contextToken: Schema.optional(Schema.String),
});
export type BridgeState = Schema.Schema.Type<typeof BridgeStateSchema>;
export const BridgeStateJsonSchema = Schema.fromJsonString(BridgeStateSchema);

export const BridgeStateV2Schema = Schema.Struct({
  version: Schema.Literal(2),
  enabled: Schema.Boolean,
  cursor: Schema.String,
  processedMessageIds: Schema.Array(Schema.String),
  pendingImageBatch: Schema.optional(PendingImageBatchSchema),
  auth: Schema.optional(WeixinAuthSchema),
  binding: Schema.optional(SessionTargetSchema),
});
export type BridgeStateV2 = Schema.Schema.Type<typeof BridgeStateV2Schema>;
export const BridgeStateV2JsonSchema = Schema.fromJsonString(BridgeStateV2Schema);

export const PiPromptProgressEventSchema = Schema.Union([
  Schema.TaggedStruct("ToolStarted", {
    runId: Schema.String,
    toolCallId: Schema.String,
    toolName: Schema.String,
  }),
  Schema.TaggedStruct("Completed", {
    runId: Schema.String,
    text: Schema.String,
  }),
]);
export type PiPromptProgressEvent = Schema.Schema.Type<typeof PiPromptProgressEventSchema>;
export type PiToolProgress = Extract<PiPromptProgressEvent, { readonly _tag: "ToolStarted" }>;
