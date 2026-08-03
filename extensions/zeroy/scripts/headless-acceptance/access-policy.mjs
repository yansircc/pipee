import { isAbsolute, relative, resolve } from "node:path";

const localFileTools = new Set(["read", "write", "edit"]);
const allowedTools = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "zeroy_inspect",
  "zeroy_checkout",
  "zeroy_push",
]);

const within = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const shellEvidence = (command) => ({
  commandSample: command.replace(/\s+/gu, " ").trim().slice(0, 240),
});

const shellCommandBoundary = String.raw`(?:^|[;&|]\s*|\n\s*|\$\(\s*)`;
const localWordPressCommand = new RegExp(
  `${shellCommandBoundary}(?:(?:command|env|sudo)\\s+)*(?:locwp|wp)(?=[\\s;&|)]|$)`,
  "u",
);
const localWordPressNetwork = new RegExp(
  `${shellCommandBoundary}(?:curl|wget)\\b[^\\n;&|]*(?:localhost|127\\.0\\.0\\.1|/wp-json/zeroy/)`,
  "u",
);
const localWordPressFilesystem = new RegExp(
  `${shellCommandBoundary}(?:cat|find|grep|head|less|ls|sed|stat|tail)\\b[^\\n;&|]*/(?:\\.locwp|wp-content)/`,
  "u",
);

export const remoteOnlyAccessViolations = ({ entries, cwd, checkoutPaths, forbiddenRoots }) => {
  const roots = checkoutPaths.map((path) => resolve(path));
  const shellScopes = roots.flatMap((root) => [root, relative(resolve(cwd), root)]);
  const forbidden = forbiddenRoots.map((path) => resolve(path));
  const violations = [];
  for (const entry of entries) {
    if (!allowedTools.has(entry.name)) {
      violations.push({
        tool: entry.name,
        reason: "tool is outside the remote-only acceptance surface",
      });
      continue;
    }
    if (localFileTools.has(entry.name)) {
      const path = typeof entry.input.path === "string" ? resolve(cwd, entry.input.path) : null;
      if (path === null || !roots.some((root) => within(root, path))) {
        violations.push({ tool: entry.name, reason: "file path escaped every Connector checkout" });
      }
      continue;
    }
    if (entry.name !== "bash") continue;
    const command = typeof entry.input.command === "string" ? entry.input.command : "";
    if (command === "") {
      violations.push({ tool: entry.name, reason: "bash command is missing" });
      continue;
    }
    if (forbidden.some((root) => command.includes(root))) {
      violations.push({
        tool: entry.name,
        reason: "command referenced repository source",
        ...shellEvidence(command),
      });
    } else if (
      localWordPressCommand.test(command) ||
      localWordPressNetwork.test(command) ||
      localWordPressFilesystem.test(command)
    ) {
      violations.push({
        tool: entry.name,
        reason: "command used a local WordPress side channel",
        ...shellEvidence(command),
      });
    } else if (!shellScopes.some((scope) => scope !== "" && command.includes(scope))) {
      violations.push({
        tool: entry.name,
        reason: "shell command was not anchored to a Connector checkout",
        ...shellEvidence(command),
      });
    }
  }
  return violations;
};
