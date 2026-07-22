import { expect, it } from "@effect/vitest";
import {
  PRESENTATION_LIMITS,
  PresentationDocument,
  type PresentationNode,
} from "@pipee/companion-contracts/presentation";
import { Schema } from "effect";

const decode = Schema.decodeUnknownSync(PresentationDocument);
const base = {
  contract: "pipee/presentation@1" as const,
  title: "Fixture",
  summary: "Ready",
  tone: "success" as const,
  icon: "extension" as const,
};

it("accepts the complete presentation node algebra", () => {
  expect(
    decode({
      ...base,
      status: { text: "Running", tone: "info" },
      body: {
        type: "group",
        direction: "column",
        gap: "medium",
        children: [
          { type: "text", text: "Body", variant: "body" },
          { type: "badge", text: "Ready", tone: "success" },
          { type: "field", label: "Owner", value: "fixture" },
          { type: "progress", value: 0.5, label: "Half" },
        ],
      },
    }),
  ).toMatchObject(base);
});

it("rejects invalid contract, visual tokens, progress, depth, node count, and text size", () => {
  for (const document of [
    { ...base, contract: "pipee/presentation@2" },
    { ...base, tone: "loud" },
    { ...base, icon: "brand-logo" },
    { ...base, status: { text: "", tone: "success" } },
    { ...base, body: { type: "progress", value: 2 } },
  ])
    expect(() => decode(document)).toThrow();

  let deep: PresentationNode = { type: "text", text: "leaf", variant: "body" };
  for (let index = 0; index < PRESENTATION_LIMITS.maxDepth; index += 1)
    deep = { type: "group", direction: "column", gap: "small", children: [deep] };
  expect(() => decode({ ...base, body: deep })).toThrow();

  expect(() =>
    decode({
      ...base,
      body: {
        type: "group",
        direction: "column",
        gap: "small",
        children: Array.from({ length: PRESENTATION_LIMITS.maxNodes }, () => ({
          type: "text" as const,
          text: "node",
          variant: "body" as const,
        })),
      },
    }),
  ).toThrow();
  expect(() =>
    decode({ ...base, summary: "x".repeat(PRESENTATION_LIMITS.maxTextLength) }),
  ).toThrow();
});
