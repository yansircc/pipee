import { expect, it } from "vite-plus/test";
import { actionRefFromEvidence, mergeActionRefs } from "../../src/protocol/action-graph.js";

it("derives executable verbs from role and state instead of per-source cases", () => {
  expect(
    actionRefFromEvidence({
      id: "el-1",
      role: "textbox",
      name: "Email",
      editable: true,
    }),
  ).toEqual({
    kind: "action",
    id: "el-1",
    role: "textbox",
    name: "Email",
    state: {},
    verbs: ["fill", "press"],
  });
  expect(
    actionRefFromEvidence({
      id: "el-2",
      role: "button",
      name: "Submit",
      disabled: true,
    }),
  ).toBeUndefined();
  expect(
    actionRefFromEvidence({
      id: "el-3",
      role: "textbox",
      name: "Attachment",
      tag: "input",
      type: "file",
    })?.verbs,
  ).toEqual(["upload"]);
});

it("unifies AX and DOM evidence by the registry ref", () => {
  expect(
    mergeActionRefs(
      [
        {
          kind: "action",
          id: "el-4",
          role: "input",
          name: "",
          state: {},
          verbs: ["fill", "press"],
        },
      ],
      [
        {
          kind: "action",
          id: "el-4",
          role: "textbox",
          name: "Account email",
          state: { focused: true },
          verbs: ["fill", "press"],
        },
      ],
      20,
    ),
  ).toEqual([
    {
      kind: "action",
      id: "el-4",
      role: "textbox",
      name: "Account email",
      state: { focused: true },
      verbs: ["fill", "press"],
    },
  ]);
});
