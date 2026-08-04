import assert from "node:assert/strict";
import { readToolLedger } from "./headless-acceptance/ledger.mjs";
import { remoteOnlyAccessViolations } from "./headless-acceptance/access-policy.mjs";

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
        {
          type: "toolCall",
          id: "call-2",
          name: "zeroy_checkout",
          arguments: { siteId: "site-1", source: "active-release" },
        },
        {
          type: "toolCall",
          id: "call-3",
          name: "zeroy_push",
          arguments: { siteId: "site-1", checkoutId: "checkout-1" },
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
  {
    index: 0,
    id: "call-2",
    name: "zeroy_checkout",
    input: { siteId: "site-1", source: "active-release" },
    result: null,
  },
  {
    index: 0,
    id: "call-3",
    name: "zeroy_push",
    input: { siteId: "site-1", checkoutId: "checkout-1" },
    result: null,
  },
]);
assert.deepEqual(
  remoteOnlyAccessViolations({
    entries: [
      { name: "read", input: { path: "checkout/.zeroy/README.md" } },
      { name: "bash", input: { command: "cd checkout && git status --short" } },
      {
        name: "bash",
        input: {
          command: 'cd checkout && echo "wp template" && grep -rn \'style="--z\' artifacts',
        },
      },
    ],
    cwd: "/tmp/acceptance",
    checkoutPaths: ["/tmp/acceptance/checkout"],
    forbiddenRoots: ["/repo/pipee"],
  }),
  [],
);
assert.deepEqual(
  remoteOnlyAccessViolations({
    entries: [
      { name: "read", input: { path: "/repo/pipee/extensions/zeroy/src/domain/protocol.ts" } },
      { name: "bash", input: { command: "locwp wp 10014 -- option get home" } },
      { name: "bash", input: { command: "cd checkout && wp option get home" } },
      {
        name: "bash",
        input: { command: "cd checkout && curl http://localhost:10014/wp-json/zeroy/v1/site" },
      },
    ],
    cwd: "/tmp/acceptance",
    checkoutPaths: ["/tmp/acceptance/checkout"],
    forbiddenRoots: ["/repo/pipee"],
  }),
  [
    { tool: "read", reason: "file path escaped every Connector checkout" },
    {
      tool: "bash",
      reason: "command used a local WordPress side channel",
      commandSample: "locwp wp 10014 -- option get home",
    },
    {
      tool: "bash",
      reason: "command used a local WordPress side channel",
      commandSample: "cd checkout && wp option get home",
    },
    {
      tool: "bash",
      reason: "command used a local WordPress side channel",
      commandSample: "cd checkout && curl http://localhost:10014/wp-json/zeroy/v1/site",
    },
  ],
);
process.stdout.write("Pi JSONL headless ledger gate passed.\n");
