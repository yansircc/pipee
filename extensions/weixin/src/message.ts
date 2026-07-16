import { createHash } from "node:crypto";
import type { IlinkImage, IlinkMessage } from "./ilink-protocol.ts";

const ILINK_TEXT_CHUNK_LIMIT = 4_000;

type InboundMessagePart =
  | { readonly _tag: "Text"; readonly text: string; readonly quote: ReadonlyArray<string> }
  | { readonly _tag: "VoiceTranscript"; readonly text: string }
  | { readonly _tag: "Image"; readonly image?: IlinkImage }
  | { readonly _tag: "Voice" }
  | { readonly _tag: "File" }
  | { readonly _tag: "Video" }
  | { readonly _tag: "Unknown"; readonly itemType?: number };

export interface InboundMessage {
  readonly parts: ReadonlyArray<InboundMessagePart>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const nonEmptyText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const referencedText = (value: unknown): string | undefined => {
  const item = record(value);
  if (!item) return undefined;
  const type = item["type"];
  if (type === 1) return nonEmptyText(record(item["text_item"])?.["text"]);
  if (type === 3) return nonEmptyText(record(item["voice_item"])?.["text"]);
  return undefined;
};

export function parseInboundMessage(message: IlinkMessage): InboundMessage {
  const parts = (message.item_list ?? []).map((item): InboundMessagePart => {
    if (item.type === 1) {
      const text = nonEmptyText(item.text_item?.text);
      const ref = item.ref_msg;
      const quote = ref
        ? [nonEmptyText(ref.title), referencedText(ref.message_item)].filter(
            (value): value is string => value !== undefined,
          )
        : [];
      return text
        ? { _tag: "Text", text, quote }
        : { _tag: "Unknown", ...(item.type === undefined ? {} : { itemType: item.type }) };
    }
    if (item.type === 2) {
      const image = item.image_item;
      const hasReference =
        image?.aeskey !== undefined ||
        image?.media?.aes_key !== undefined ||
        image?.media?.encrypt_query_param !== undefined ||
        image?.media?.full_url !== undefined;
      return { _tag: "Image", ...(hasReference && image ? { image } : {}) };
    }
    if (item.type === 3) {
      const text = nonEmptyText(item.voice_item?.text);
      return text ? { _tag: "VoiceTranscript", text } : { _tag: "Voice" };
    }
    if (item.type === 4) return { _tag: "File" };
    if (item.type === 5) return { _tag: "Video" };
    return { _tag: "Unknown", ...(item.type === undefined ? {} : { itemType: item.type }) };
  });
  return { parts };
}

export function renderInboundPrompt(message: InboundMessage): string | undefined {
  const text = message.parts.flatMap((part) => {
    if (part._tag === "VoiceTranscript") return [part.text];
    if (part._tag !== "Text") return [];
    return [part.quote.length > 0 ? `[引用: ${part.quote.join(" | ")}]\n${part.text}` : part.text];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

export function splitTextReply(text: string): ReadonlyArray<string> {
  const scalars = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < scalars.length; offset += ILINK_TEXT_CHUNK_LIMIT) {
    chunks.push(scalars.slice(offset, offset + ILINK_TEXT_CHUNK_LIMIT).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

export function messageIdentity(message: unknown): string {
  if (message && typeof message === "object") {
    const wire = message as Record<string, unknown>;
    if (typeof wire["message_id"] === "number" && Number.isFinite(wire["message_id"])) {
      return `message-${wire["message_id"]}`;
    }
    if (typeof wire["client_id"] === "string" && wire["client_id"]) {
      return `client-${wire["client_id"]}`;
    }
  }
  return createHash("sha256").update(canonicalJson(message)).digest("hex");
}

export const messageBatchIdentity = (messageIds: ReadonlyArray<string>): string =>
  `batch-${createHash("sha256").update(messageIds.join("\0")).digest("hex")}`;

const outboundClientId = (messageId: string, part: string): string => {
  const digest = createHash("sha256").update(`${messageId}\0${part}`).digest("hex");
  return `piw-${digest.slice(0, 32)}`;
};

export const replyClientId = (messageId: string, chunkIndex: number): string =>
  outboundClientId(messageId, `reply:${chunkIndex}`);

export const progressClientId = (messageId: string, toolCallId: string): string =>
  outboundClientId(messageId, `tool:${toolCallId}`);
