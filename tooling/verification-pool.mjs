import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import process from "node:process";

const maximumJobs = 64;
const maximumDefaultPipelines = 4;

export const verificationJobs = ({
  environment = process.env,
  available = availableParallelism(),
} = {}) => {
  const override = environment.PIPEE_VERIFY_JOBS;
  if (override !== undefined) {
    if (!/^[1-9]\d*$/.test(override)) {
      throw new Error("PIPEE_VERIFY_JOBS must be a positive integer");
    }
    const jobs = Number(override);
    if (!Number.isSafeInteger(jobs) || jobs > maximumJobs) {
      throw new Error(`PIPEE_VERIFY_JOBS must not exceed ${maximumJobs}`);
    }
    return jobs;
  }
  return Math.max(1, Math.min(available, maximumDefaultPipelines));
};

export class VerificationTaskError extends Error {
  constructor(task, exitCode) {
    super(`verification task ${task.id} exited ${exitCode}`);
    this.name = "VerificationTaskError";
    this.task = task;
    this.exitCode = exitCode;
  }
}

export const runCommandTask = (task, signal) =>
  new Promise((resolve, reject) => {
    const child = spawn(task.command, task.arguments, {
      cwd: task.cwd,
      env: task.environment ?? process.env,
      stdio: "inherit",
    });
    let settled = false;
    const settle = (complete) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    };
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => {
      settle(() => {
        if (code === 0) resolve();
        else reject(new VerificationTaskError(task, code ?? 1));
      });
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

export const runVerificationPool = async (
  tasks,
  {
    jobs = verificationJobs(),
    run = runCommandTask,
    onStart = (task) => process.stdout.write(`[verify:start] ${task.id}\n`),
    onFinish = (task, elapsed) =>
      process.stdout.write(`[verify:pass] ${task.id} (${(elapsed / 1_000).toFixed(1)}s)\n`),
  } = {},
) => {
  if (!Number.isSafeInteger(jobs) || jobs < 1)
    throw new Error("verification jobs must be positive");
  const controller = new AbortController();
  let next = 0;
  let failure;

  const abort = () => controller.abort(new Error("verification interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const worker = async () => {
    while (failure === undefined && !controller.signal.aborted) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      const startedAt = Date.now();
      onStart(task);
      try {
        await run(task, controller.signal);
        onFinish(task, Date.now() - startedAt);
      } catch (error) {
        if (failure === undefined) {
          failure = error;
          controller.abort(error);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }

  if (failure !== undefined) throw failure;
  if (controller.signal.aborted) throw controller.signal.reason;
};
