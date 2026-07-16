import { expect, it } from "@effect/vitest";
import {
  messageIdentity,
  parseInboundMessage,
  progressClientId,
  renderInboundPrompt,
  replyClientId,
  splitTextReply,
} from "../src/message.ts";

it("message identity is independent of object key order", () => {
  const left = {
    from_user_id: "u1",
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: "hi" } }],
  };
  const right = {
    item_list: [{ text_item: { text: "hi" }, type: 1 }],
    message_type: 1,
    from_user_id: "u1",
  };
  expect(messageIdentity(left)).toBe(messageIdentity(right));
  expect(replyClientId(messageIdentity(left), 0)).toBe(replyClientId(messageIdentity(right), 0));
});

it("prefers the server message identity over payload hashing", () => {
  expect(messageIdentity({ message_id: 42, item_list: [{ type: 1 }] })).toBe("message-42");
  expect(messageIdentity({ client_id: "client-7", item_list: [] })).toBe("client-client-7");
});

it("renders text, quoted context, and server voice transcripts from one message algebra", () => {
  const message = parseInboundMessage({
    item_list: [
      {
        type: 1,
        text_item: { text: " continue " },
        ref_msg: {
          title: "original title",
          message_item: { type: 1, text_item: { text: "original body" } },
        },
      },
      { type: 2, image_item: {} },
      { type: 3, voice_item: { text: "voice transcript" } },
    ],
  });

  expect(message.parts).toEqual([
    {
      _tag: "Text",
      text: "continue",
      quote: ["original title", "original body"],
    },
    { _tag: "Image" },
    { _tag: "VoiceTranscript", text: "voice transcript" },
  ]);
  expect(renderInboundPrompt(message)).toBe(
    "[引用: original title | original body]\ncontinue\nvoice transcript",
  );
});

it("does not flatten quoted media into a fake text reference", () => {
  expect(
    renderInboundPrompt(
      parseInboundMessage({
        item_list: [
          {
            type: 1,
            text_item: { text: "look at this" },
            ref_msg: { message_item: { type: 2, image_item: {} } },
          },
        ],
      }),
    ),
  ).toBe("look at this");
});

it("preserves an untranscribed Weixin voice as a distinct message part", () => {
  expect(
    parseInboundMessage({ item_list: [{ type: 3, voice_item: { media: {} } }] }).parts,
  ).toEqual([{ _tag: "Voice" }]);
});

it("splits long replies on Unicode scalar boundaries with deterministic chunk ids", () => {
  const chunks = splitTextReply(`${"a".repeat(3_999)}😀tail`);
  expect(chunks).toEqual([`${"a".repeat(3_999)}😀`, "tail"]);
  expect(Array.from(chunks[0] ?? "")).toHaveLength(4_000);
  expect(replyClientId("message-42", 0)).not.toBe(replyClientId("message-42", 1));
  expect(progressClientId("message-42", "tool-1")).toBe(progressClientId("message-42", "tool-1"));
  expect(progressClientId("message-42", "tool-1")).not.toBe(replyClientId("message-42", 0));
  expect(replyClientId("message-42", 0)).toMatch(/^piw-[a-f0-9]{32}$/);
});
