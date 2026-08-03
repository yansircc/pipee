import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectVerificationTasks } from "./verification-plan.mjs";

test("projects package gates without recursively scheduling the workspace root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipee-verification-plan-"));
  const packageRoot = join(root, "packages", "example");
  try {
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "workspace", scripts: { verify: "node verify.mjs" } }),
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "example", scripts: { verify: "node verify.mjs" } }),
    );

    const tasks = projectVerificationTasks({
      projects: [{ path: root }, { path: packageRoot }],
      workspaceRoot: `${root}/`,
      packageManagerEntry: "/pnpm.cjs",
    });

    assert.deepEqual(
      tasks.map(({ id }) => id),
      ["package:example"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
