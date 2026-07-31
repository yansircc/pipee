import assert from "node:assert/strict";
import { readToolLedger } from "./headless-acceptance/ledger.mjs";

const calls = readToolLedger([
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          toolCallId: "call-1",
          toolName: "zeroy_inspect",
          input: { resource: "sites" },
        },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "zeroy_inspect",
      content: [{ type: "text", text: '{"contract":"zeroy/configured-sites@1"}' }],
      isError: false,
    },
  },
]);

assert.deepEqual(calls, [
  {
    index: 0,
    id: "call-1",
    name: "zeroy_inspect",
    input: { resource: "sites" },
    result: {
      isError: false,
      text: '{"contract":"zeroy/configured-sites@1"}',
      payload: { contract: "zeroy/configured-sites@1" },
    },
  },
]);
process.stdout.write("Pi JSONL headless ledger gate passed.\n");
