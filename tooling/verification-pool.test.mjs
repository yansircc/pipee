import assert from "node:assert/strict";
import test from "node:test";
import { runVerificationPool, verificationJobs } from "./verification-pool.mjs";

test("derives the default worker count from available CPU capacity", () => {
  assert.equal(verificationJobs({ environment: {}, available: 10 }), 4);
  assert.equal(verificationJobs({ environment: {}, available: 2 }), 2);
  assert.equal(verificationJobs({ environment: {}, available: 1 }), 1);
  assert.equal(verificationJobs({ environment: { PIPEE_VERIFY_JOBS: "10" }, available: 2 }), 10);
  assert.throws(
    () => verificationJobs({ environment: { PIPEE_VERIFY_JOBS: "0" }, available: 10 }),
    /positive integer/,
  );
  assert.throws(
    () => verificationJobs({ environment: { PIPEE_VERIFY_JOBS: "65" }, available: 10 }),
    /must not exceed/,
  );
});

test("bounds all verification tasks by one global worker budget", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed = [];
  const tasks = Array.from({ length: 12 }, (_, index) => ({ id: `task-${index}` }));

  await runVerificationPool(tasks, {
    jobs: 4,
    onStart: () => {},
    onFinish: () => {},
    run: async (task) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed.push(task.id);
      active -= 1;
    },
  });

  assert.equal(maximumActive, 4);
  assert.equal(completed.length, tasks.length);
});

test("aborts running work and does not schedule the remaining queue after failure", async () => {
  const started = [];
  const tasks = Array.from({ length: 10 }, (_, index) => ({ id: `task-${index}` }));

  await assert.rejects(
    runVerificationPool(tasks, {
      jobs: 2,
      onStart: () => {},
      onFinish: () => {},
      run: (task, signal) => {
        started.push(task.id);
        if (task.id === "task-0") return Promise.reject(new Error("gate failed"));
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, 1_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }),
    /gate failed/,
  );

  assert.deepEqual(started, ["task-0", "task-1"]);
});
