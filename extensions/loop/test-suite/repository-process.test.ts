import { expect, it } from "@effect/vitest";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { createLoop, DEFAULT_CONFIG } from "../src/domain/model.js";

const worker = fileURLToPath(new URL("./repository-process-worker.ts", import.meta.url));

const firstLine = (child: ChildProcess): Promise<string> => {
  if (child.stdout === null || child.stderr === null)
    return Promise.reject(new Error("repository worker must own piped output"));
  const { stdout, stderr } = child;
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end >= 0) resolve(output.slice(0, end));
    });
    child.once("error", reject);
    stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      if (!output.includes("\n"))
        reject(new Error(`repository worker exited ${String(code)}: ${errorOutput}`));
    });
  });
};

it("persists each occurrence once and lets a live follower take over after owner exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-loop-process-"));
  const durable = {
    version: 2,
    loops: [
      createLoop({
        _tag: "Once",
        id: "cross-process-once",
        prompt: "run exactly once",
        retention: "project",
        createdAt: 1,
        dueAt: 10,
      }),
      createLoop({
        _tag: "Once",
        id: "cross-process-successor",
        prompt: "run after takeover",
        retention: "project",
        createdAt: 1,
        dueAt: 20,
      }),
    ],
  };
  writeFileSync(join(directory, DEFAULT_CONFIG.durableFilePath), JSON.stringify(durable));
  const start = () =>
    crossSpawn("jiti", [worker, directory], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  const owner = start();
  let follower: ChildProcess | undefined;
  try {
    const ownerResult = JSON.parse(await firstLine(owner)) as {
      access: "owner" | "follower";
      ids: ReadonlyArray<string>;
    };
    const startedFollower = start();
    follower = startedFollower;
    const followerResult = JSON.parse(await firstLine(startedFollower)) as {
      access: "owner" | "follower";
      ids: ReadonlyArray<string>;
    };
    expect(ownerResult).toEqual({ access: "owner", ids: ["cross-process-once:0"] });
    expect(followerResult).toEqual({ access: "follower", ids: [] });
    const followerTakeover = firstLine(startedFollower);
    const ownerExit = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
    owner.kill();
    await ownerExit;
    expect(JSON.parse(await followerTakeover)).toEqual({
      access: "inactive",
      ids: ["cross-process-successor:0"],
    });
  } finally {
    const running = [owner, follower].filter(
      (child): child is ChildProcess => child !== undefined && child.exitCode === null,
    );
    const exits = running.map(
      (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
    );
    for (const child of running) child.kill();
    await Promise.all(exits);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
