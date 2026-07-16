import { expect, it } from "@effect/vitest";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";

const worker = fileURLToPath(new URL("./account-owner-worker.ts", import.meta.url));

const start = (home: string, statePath: string) =>
  crossSpawn("jiti", [worker, home, statePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

const firstLine = (child: ChildProcess): Promise<string> => {
  if (child.stdout === null || child.stderr === null)
    return Promise.reject(new Error("account worker must own piped output"));
  const { stdout, stderr } = child;
  return new Promise((resolveLine, reject) => {
    let output = "";
    let errorOutput = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const result = output
        .split(/\r?\n/)
        .find((line) => line === "acquired" || line === "unavailable");
      if (result !== undefined) resolveLine(result);
    });
    stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.split(/\r?\n/).some((line) => line === "acquired" || line === "unavailable"))
        reject(new Error(`account worker exited ${String(code)}: ${output}${errorOutput}`));
    });
  });
};

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((resolveExit) => child.once("exit", () => resolveExit()));

it("admits one account poller across processes and releases it on owner exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-weixin-process-account-"));
  const state = {
    version: 2,
    enabled: true,
    cursor: "",
    processedMessageIds: [],
    auth: {
      token: "secret",
      baseUrl: "http://127.0.0.1:9",
      accountId: "shared-process-account",
      userId: "user",
      savedAt: "now",
    },
    binding: { sessionId: "session", cwd: home },
  };
  const stateA = join(home, "states", "a.json");
  const stateB = join(home, "states", "b.json");
  mkdirSync(dirname(stateA), { recursive: true });
  writeFileSync(stateA, JSON.stringify(state));
  writeFileSync(stateB, JSON.stringify(state));
  const owner = start(home, stateA);
  let contender: ChildProcess | undefined;
  let successor: ChildProcess | undefined;
  try {
    expect(await firstLine(owner)).toBe("acquired");
    const startedContender = start(home, stateB);
    contender = startedContender;
    expect(await firstLine(startedContender)).toBe("unavailable");
    await exited(startedContender);

    const ownerExit = exited(owner);
    owner.kill();
    await ownerExit;
    const startedSuccessor = start(home, stateB);
    successor = startedSuccessor;
    expect(await firstLine(startedSuccessor)).toBe("acquired");
  } finally {
    const running = [owner, contender, successor].filter(
      (child): child is ChildProcess => child !== undefined && child.exitCode === null,
    );
    const exits = running.map(exited);
    for (const child of running) child.kill();
    await Promise.all(exits);
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
