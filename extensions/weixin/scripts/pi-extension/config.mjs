export default Object.freeze({
  source: "extensions/weixin.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "single-file",
    assets: Object.freeze([]),
  }),
  expected: Object.freeze({
    commands: Object.freeze(["weixin"]),
    tools: Object.freeze([]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
  }),
});
