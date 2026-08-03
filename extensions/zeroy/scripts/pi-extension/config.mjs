export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "multi-file",
    assets: Object.freeze(["dist/web", "wordpress-plugin"]),
  }),
  expected: Object.freeze({
    commands: Object.freeze([]),
    tools: Object.freeze(["zeroy_checkout", "zeroy_inspect", "zeroy_push"]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
    skills: Object.freeze([]),
  }),
});
