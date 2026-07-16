import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export class SmokeFailure extends Error {
  override readonly name = "SmokeFailure";
}

export class SmokeSkip extends Error {
  override readonly name = "SmokeSkip";
}

export type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
  readonly reject: (reason?: unknown) => void;
};

export const deferred = <Value = void>(): Deferred<Value> => {
  let resolve!: Deferred<Value>["resolve"];
  let reject!: Deferred<Value>["reject"];
  const promise = new Promise<Value>((resume, fail) => {
    resolve = resume;
    reject = fail;
  });
  return { promise, resolve, reject };
};

export const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export const withTimeout = async <Value>(
  promise: Promise<Value>,
  label: string,
  timeoutMs: number = 30_000,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SmokeFailure(`Timed out waiting for ${label} after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const waitForCondition = async <Value>(
  probe: () => Promise<Value | undefined | false>,
  label: string,
  timeoutMs: number = 10_000,
): Promise<Value> => {
  const started = Date.now();
  while (true) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new SmokeFailure(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await delay(100);
  }
};

export const errorOf = (cause: unknown, message: string): Error =>
  cause instanceof Error ? cause : new SmokeFailure(message, { cause });
