export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "single-file",
    assets: Object.freeze([]),
  }),
  expected: Object.freeze({
    commands: Object.freeze([]),
    tools: Object.freeze([
      "loop_create",
      "loop_delete",
      "loop_list",
      "loop_pause",
      "loop_resume",
      "loop_run_now",
      "loop_update",
      "schedule_wakeup",
    ]),
    handlers: Object.freeze(["agent_end", "agent_start", "session_shutdown", "session_start"]),
  }),
});
