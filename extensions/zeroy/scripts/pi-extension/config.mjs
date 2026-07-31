export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "multi-file",
    assets: Object.freeze(["dist/web", "wordpress-plugin", "mvp-theme"]),
  }),
  expected: Object.freeze({
    commands: Object.freeze([]),
    tools: Object.freeze([
      "zeroy_content_apply",
      "zeroy_inspect",
      "zeroy_theme_checkout",
      "zeroy_theme_push",
    ]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
    skills: Object.freeze([]),
  }),
});
