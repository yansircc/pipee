export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "multi-file",
    assets: Object.freeze([
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "dist/browser-extension",
      "docs",
      "SECURITY.md",
    ]),
  }),
  expected: Object.freeze({
    commands: Object.freeze(["chrome"]),
    tools: Object.freeze([]),
    handlers: Object.freeze([
      "agent_settled",
      "before_agent_start",
      "session_shutdown",
      "session_start",
      "session_tree",
    ]),
  }),
});
