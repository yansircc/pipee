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
      "zeroy_site_checkout",
      "zeroy_site_verify",
      "zeroy_site_push",
    ]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
    skills: Object.freeze([]),
  }),
});
