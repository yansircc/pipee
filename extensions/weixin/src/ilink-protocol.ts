import { Effect, Schema } from "effect";
import packageMetadata from "../package.json" with { type: "json" };
import { IlinkProtocolError } from "./errors.ts";

export const DEFAULT_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const ILINK_BOT_TYPE = "3";
export const ILINK_CHANNEL_VERSION = packageMetadata.ilink.clientVersion;
export const ILINK_APP_ID = packageMetadata.ilink.appId;
export const ILINK_BOT_AGENT = `pi-weixin/${packageMetadata.version}`;

export const encodeIlinkClientVersion = (
  version: string,
): Effect.Effect<number, IlinkProtocolError> => {
  const parts = version.split(".").map(Number);
  if (
    parts.length !== 3 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xff)
  ) {
    return Effect.fail(
      new IlinkProtocolError({
        operation: "ilink.client_version",
        cause: `Invalid iLink client version: ${version}`,
      }),
    );
  }
  const [major, minor, patch] = parts as [number, number, number];
  return Effect.succeed(((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff));
};

export const ILINK_APP_CLIENT_VERSION = encodeIlinkClientVersion(ILINK_CHANNEL_VERSION);

export const IlinkResponseSchema = Schema.Struct({
  ret: Schema.optional(Schema.Finite),
  errcode: Schema.optional(Schema.Finite),
  errmsg: Schema.optional(Schema.String),
});

export const IlinkIdSchema = Schema.Union([Schema.String, Schema.Finite]);

export const SendMessageResponseSchema = Schema.Struct({
  ...IlinkResponseSchema.fields,
  message_id: IlinkIdSchema,
});

const CdnMediaSchema = Schema.Struct({
  encrypt_query_param: Schema.optional(Schema.String),
  aes_key: Schema.optional(Schema.String),
  full_url: Schema.optional(Schema.String),
});

export const IlinkImageSchema = Schema.Struct({
  media: Schema.optional(CdnMediaSchema),
  aeskey: Schema.optional(Schema.String),
});
export type IlinkImage = Schema.Schema.Type<typeof IlinkImageSchema>;

const IlinkItemSchema = Schema.Struct({
  type: Schema.optional(Schema.Finite),
  text_item: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
  image_item: Schema.optional(IlinkImageSchema),
  voice_item: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String),
      media: Schema.optional(Schema.Unknown),
    }),
  ),
  file_item: Schema.optional(Schema.Unknown),
  video_item: Schema.optional(Schema.Unknown),
  ref_msg: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      message_item: Schema.optional(
        Schema.Struct({
          msg_id: Schema.optional(IlinkIdSchema),
          type: Schema.optional(Schema.Finite),
          text_item: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
          voice_item: Schema.optional(
            Schema.Struct({
              text: Schema.optional(Schema.String),
              media: Schema.optional(Schema.Unknown),
            }),
          ),
          image_item: Schema.optional(IlinkImageSchema),
          file_item: Schema.optional(Schema.Unknown),
          video_item: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
});

export const IlinkMessageSchema = Schema.Struct({
  seq: Schema.optional(Schema.Finite),
  message_id: Schema.optional(IlinkIdSchema),
  client_id: Schema.optional(Schema.String),
  create_time_ms: Schema.optional(Schema.Finite),
  message_type: Schema.optional(Schema.Finite),
  from_user_id: Schema.optional(Schema.String),
  context_token: Schema.optional(Schema.String),
  item_list: Schema.optional(Schema.Array(IlinkItemSchema)),
});
export type IlinkMessage = Schema.Schema.Type<typeof IlinkMessageSchema>;

export const UpdatesResponseSchema = Schema.Struct({
  ...IlinkResponseSchema.fields,
  msgs: Schema.optional(Schema.Array(Schema.Unknown)),
  get_updates_buf: Schema.optional(Schema.String),
  longpolling_timeout_ms: Schema.optional(Schema.Finite),
});
export type UpdatesResponse = Schema.Schema.Type<typeof UpdatesResponseSchema>;

export const LoginQrResponseSchema = Schema.Struct({
  ...IlinkResponseSchema.fields,
  qrcode: Schema.String,
  qrcode_img_content: Schema.String,
});

const LoginStatusSchema = Schema.Literals([
  "wait",
  "scaned",
  "confirmed",
  "expired",
  "scaned_but_redirect",
  "binded_redirect",
  "need_verifycode",
  "verify_code_blocked",
]);
export type LoginStatus = Schema.Schema.Type<typeof LoginStatusSchema>;

export const LoginStatusResponseSchema = Schema.Struct({
  ...IlinkResponseSchema.fields,
  status: LoginStatusSchema,
  bot_token: Schema.optional(Schema.String),
  baseurl: Schema.optional(Schema.String),
  ilink_bot_id: Schema.optional(Schema.String),
  ilink_user_id: Schema.optional(Schema.String),
  redirect_host: Schema.optional(Schema.String),
});
export type LoginStatusResponse = Schema.Schema.Type<typeof LoginStatusResponseSchema>;

export const TypingConfigResponseSchema = Schema.Struct({
  ...IlinkResponseSchema.fields,
  typing_ticket: Schema.optional(Schema.String),
});
