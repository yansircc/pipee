import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

export const projectVerificationTasks = ({ projects, workspaceRoot, packageManagerEntry }) => {
  const canonicalWorkspaceRoot = resolve(workspaceRoot);
  return projects.flatMap((project) => {
    const path = resolve(project.path);
    if (path === canonicalWorkspaceRoot) return [];
    const manifest = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
    if (typeof manifest.scripts?.verify !== "string") return [];
    return [
      {
        id: `package:${manifest.name}`,
        command: process.execPath,
        arguments: [packageManagerEntry, "--dir", path, "run", "verify"],
        cwd: workspaceRoot,
      },
    ];
  });
};

export const packageVerificationTasks = ({ workspaceRoot, packageManagerEntry }) =>
  projectVerificationTasks({
    projects: JSON.parse(
      execFileSync(
        process.execPath,
        [packageManagerEntry, "list", "--recursive", "--depth", "-1", "--json"],
        { cwd: workspaceRoot, encoding: "utf8" },
      ),
    ),
    workspaceRoot,
    packageManagerEntry,
  });

export const repositoryVerificationTasks = ({ workspaceRoot, packageManagerEntry }) =>
  ["check:brand", "check:workspace", "test:tooling", "test:release"].map((script) => ({
    id: `repository:${script}`,
    command: process.execPath,
    arguments: [packageManagerEntry, "run", script],
    cwd: workspaceRoot,
  }));
