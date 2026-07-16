import { expect, it } from "@effect/vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./lease-worker.ts", import.meta.url));

const start = (path: string, mode: "hold" | "try") =>
  spawn(process.execPath, ["--experimental-strip-types", worker, path, mode], {
    stdio: ["pipe", "pipe", "pipe"],
  });

const firstLine = (child: ChildProcessWithoutNullStreams): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lineEnd = output.indexOf("\n");
      if (lineEnd >= 0) resolve(output.slice(0, lineEnd));
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`lease worker exited ${String(code)}`));
    });
  });

const exited = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve) => child.once("exit", () => resolve()));

it("releases the lease when an owner process is terminated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-suite-lease-process-"));
  const path = join(directory, "owner.lease.sqlite");
  const owner = start(path, "hold");
  try {
    expect(await firstLine(owner)).toBe("acquired");

    const contender = start(path, "try");
    expect(await firstLine(contender)).toBe("unavailable");
    await exited(contender);

    owner.kill();
    await exited(owner);

    const successor = start(path, "try");
    expect(await firstLine(successor)).toBe("acquired");
    await exited(successor);
  } finally {
    if (owner.exitCode === null) owner.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

it("admits exactly one owner across eight independent processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-suite-lease-eight-processes-"));
  const path = join(directory, "contended.lease.sqlite");
  const contenders = Array.from({ length: 8 }, () => start(path, "hold"));
  try {
    const results = await Promise.all(contenders.map(firstLine));
    expect(results.filter((result) => result === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result === "unavailable")).toHaveLength(7);
  } finally {
    const running = contenders.filter((contender) => contender.exitCode === null);
    const exits = running.map(exited);
    for (const contender of running) contender.kill();
    await Promise.all(exits);
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
