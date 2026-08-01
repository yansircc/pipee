export default Object.freeze({
  source: "src/pi/extension.ts",
  hostModules: Object.freeze(["@earendil-works/pi-coding-agent"]),
  profile: Object.freeze({
    kind: "multi-file",
    assets: Object.freeze(["dist/web", "wordpress-plugin"]),
  }),
  expected: Object.freeze({
    commands: Object.freeze([]),
    tools: Object.freeze([
      "zeroy_content_stage",
      "zeroy_inspect",
      "zeroy_site_commit",
      "zeroy_artifact_stage",
    ]),
    handlers: Object.freeze(["session_shutdown", "session_start"]),
    skills: Object.freeze([]),
  }),
});
