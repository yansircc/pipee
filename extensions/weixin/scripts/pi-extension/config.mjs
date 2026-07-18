export default Object.freeze({
  source: "extensions/weixin.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "single-file",
    assets: Object.freeze([]),
  }),
  expected: Object.freeze({
    commands: Object.freeze([]),
    tools: Object.freeze([
      "weixin_connect",
      "weixin_disconnect",
      "weixin_logout",
      "weixin_send",
      "weixin_set_default",
      "weixin_status",
    ]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
    skills: Object.freeze([]),
  }),
});
