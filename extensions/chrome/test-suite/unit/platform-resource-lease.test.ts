import { expect, it, vi } from "vite-plus/test";
import { withResourceLease } from "../../src/browser/platform-resource-lease.js";

it("releases only a resource whose acquisition completed", async () => {
  const release = vi.fn(async () => undefined);
  await expect(
    withResourceLease(
      async () => {
        throw new Error("acquire failed");
      },
      async () => undefined,
      release,
    ),
  ).rejects.toThrow("acquire failed");
  expect(release).not.toHaveBeenCalled();
});

it("releases after both successful and failed resource use", async () => {
  const released: string[] = [];
  await expect(
    withResourceLease(
      async () => "success",
      async () => 42,
      async (resource) => {
        released.push(resource);
      },
    ),
  ).resolves.toBe(42);
  await expect(
    withResourceLease(
      async () => "failure",
      async () => {
        throw new Error("use failed");
      },
      async (resource) => {
        released.push(resource);
      },
    ),
  ).rejects.toThrow("use failed");
  expect(released).toEqual(["success", "failure"]);
});

it("preserves both the use and release failures", async () => {
  const failure = await withResourceLease(
    async () => "resource",
    async () => {
      throw new Error("use failed");
    },
    async () => {
      throw new Error("release failed");
    },
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([
    expect.objectContaining({ message: "use failed" }),
    expect.objectContaining({ message: "release failed" }),
  ]);
});
