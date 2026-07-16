import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { replaceDirectoryWithRollback } from "../../scripts/directory-replacement.js";

const withSandbox = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chrome-directory-replacement-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

it("leaves the previous output untouched when staging fails", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "previous");

    await expect(
      replaceDirectoryWithRollback(destination, {
        prepare: async (staging) => {
          await writeFile(join(staging, "marker"), "incomplete");
          throw new Error("staging failed");
        },
        validate: async () => undefined,
      }),
    ).rejects.toThrow("staging failed");

    expect(await readFile(join(destination, "marker"), "utf8")).toBe("previous");
    expect(await readdir(sandbox)).toEqual(["extension"]);
  }));

it("keeps the last-known-good output when staged validation fails", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "last-known-good");

    await expect(
      replaceDirectoryWithRollback(destination, {
        prepare: async (staging) => {
          await writeFile(join(staging, "marker"), "invalid-candidate");
        },
        validate: async () => {
          throw new Error("candidate validation failed");
        },
      }),
    ).rejects.toThrow("candidate validation failed");

    expect(await readFile(join(destination, "marker"), "utf8")).toBe("last-known-good");
    expect(await readdir(sandbox)).toEqual(["extension"]);
  }));

it("preserves both the primary failure and a staging cleanup failure", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "last-known-good");

    let failure: unknown;
    try {
      await replaceDirectoryWithRollback(destination, {
        prepare: async (staging) => writeFile(join(staging, "marker"), "incomplete"),
        validate: async () => {
          throw new Error("candidate validation failed");
        },
        removeDirectory: async (path) => {
          if (path.includes(".extension.stage-")) throw new Error("staging cleanup denied");
          await rm(path, { recursive: true, force: true });
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "candidate validation failed" }),
      expect.objectContaining({ message: "staging cleanup denied" }),
    ]);
    expect(await readFile(join(destination, "marker"), "utf8")).toBe("last-known-good");
  }));

it("restores the previous output when the publish rename fails", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "previous");

    await expect(
      replaceDirectoryWithRollback(destination, {
        prepare: async (staging) => {
          await writeFile(join(staging, "marker"), "complete");
        },
        validate: async (staging) => {
          expect(await readFile(join(staging, "marker"), "utf8")).toBe("complete");
        },
        renameDirectory: async (source, target) => {
          if (source.includes(".extension.stage-") && target === destination) {
            throw new Error("publish rename failed");
          }
          await rename(source, target);
        },
      }),
    ).rejects.toThrow("publish rename failed");

    expect(await readFile(join(destination, "marker"), "utf8")).toBe("previous");
    expect(await readdir(sandbox)).toEqual(["extension"]);
  }));

it("recovers the unique last-known-good backup and clears interrupted staging before rebuilding", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    const backup = join(sandbox, ".extension.backup-interrupted");
    const staleStage = join(sandbox, ".extension.stage-interrupted");
    await mkdir(backup);
    await writeFile(join(backup, "marker"), "last-known-good");
    await mkdir(staleStage);
    await writeFile(join(staleStage, "marker"), "incomplete");

    await replaceDirectoryWithRollback(destination, {
      prepare: async (staging) => {
        expect(await readFile(join(destination, "marker"), "utf8")).toBe("last-known-good");
        expect(new Set(await readdir(sandbox))).toEqual(new Set(["extension", basename(staging)]));
        await writeFile(join(staging, "marker"), "replacement");
      },
      validate: async () => undefined,
    });

    expect(await readFile(join(destination, "marker"), "utf8")).toBe("replacement");
    expect(await readdir(sandbox)).toEqual(["extension"]);
  }));

it("fails closed when interrupted publishing leaves multiple recovery backups", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    const firstBackup = join(sandbox, ".extension.backup-first");
    const secondBackup = join(sandbox, ".extension.backup-second");
    const staleStage = join(sandbox, ".extension.stage-interrupted");
    await Promise.all([mkdir(firstBackup), mkdir(secondBackup), mkdir(staleStage)]);
    const prepare = vi.fn(async () => undefined);

    await expect(
      replaceDirectoryWithRollback(destination, {
        prepare,
        validate: async () => undefined,
      }),
    ).rejects.toThrow("multiple last-known-good backups");

    expect(prepare).not.toHaveBeenCalled();
    expect(await readdir(sandbox)).toEqual([".extension.backup-first", ".extension.backup-second"]);
  }));

it("reports backup cleanup failure instead of accumulating it silently", () =>
  withSandbox(async (sandbox) => {
    const destination = join(sandbox, "extension");
    await mkdir(destination);
    await writeFile(join(destination, "marker"), "previous");
    const removeDirectory = vi.fn(async (path: string) => {
      if (path.includes(".extension.backup-")) throw new Error("backup cleanup denied");
      await rm(path, { recursive: true, force: true });
    });

    await expect(
      replaceDirectoryWithRollback(destination, {
        prepare: async (staging) => writeFile(join(staging, "marker"), "replacement"),
        validate: async () => undefined,
        removeDirectory,
      }),
    ).rejects.toThrow("backup cleanup denied");

    expect(await readFile(join(destination, "marker"), "utf8")).toBe("replacement");
    expect((await readdir(sandbox)).some((entry) => entry.startsWith(".extension.backup-"))).toBe(
      true,
    );

    await replaceDirectoryWithRollback(destination, {
      prepare: async (staging) => writeFile(join(staging, "marker"), "next replacement"),
      validate: async () => undefined,
    });
    expect(await readFile(join(destination, "marker"), "utf8")).toBe("next replacement");
    expect(await readdir(sandbox)).toEqual(["extension"]);
  }));
