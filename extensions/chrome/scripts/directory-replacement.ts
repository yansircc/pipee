import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type RenameDirectory = (source: string, destination: string) => Promise<void>;
type RemoveDirectory = (path: string) => Promise<void>;

export interface DirectoryReplacementOptions {
  readonly prepare: (stagingDirectory: string) => Promise<void>;
  readonly validate: (stagingDirectory: string) => Promise<void>;
  readonly renameDirectory?: RenameDirectory;
  readonly removeDirectory?: RemoveDirectory;
}

const isMissingPath = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
};

const recoverInterruptedReplacement = async (
  destination: string,
  renameDirectory: RenameDirectory,
  removeDirectory: RemoveDirectory,
): Promise<void> => {
  const parent = dirname(destination);
  const name = basename(destination);
  const entries = await readdir(parent);
  const stagingPrefix = `.${name}.stage-`;
  const backupPrefix = `.${name}.backup-`;
  const staleStages = entries.filter((entry) => entry.startsWith(stagingPrefix)).sort();
  const backups = entries.filter((entry) => entry.startsWith(backupPrefix)).sort();

  for (const stage of staleStages) await removeDirectory(join(parent, stage));

  if (backups.length > 1) {
    throw new Error(
      `Cannot recover ${destination}: multiple last-known-good backups exist: ${backups.join(", ")}`,
    );
  }

  const backup = backups[0];
  if (!backup) return;
  const backupPath = join(parent, backup);
  if (await pathExists(destination)) {
    await removeDirectory(backupPath);
  } else {
    await renameDirectory(backupPath, destination);
  }
};

export const replaceDirectoryWithRollback = async (
  destination: string,
  options: DirectoryReplacementOptions,
): Promise<void> => {
  const parent = dirname(destination);
  const name = basename(destination);
  const renameDirectory = options.renameDirectory ?? rename;
  const removeDirectory =
    options.removeDirectory ?? ((path: string) => rm(path, { recursive: true, force: true }));
  await mkdir(parent, { recursive: true });
  await recoverInterruptedReplacement(destination, renameDirectory, removeDirectory);

  const staging = await mkdtemp(join(parent, `.${name}.stage-`));
  const backup = join(parent, `.${name}.backup-${randomUUID()}`);
  let stagingExists = true;
  let backupExists = false;
  const failures: Array<unknown> = [];

  try {
    await options.prepare(staging);
    await options.validate(staging);

    try {
      await renameDirectory(destination, backup);
      backupExists = true;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }

    try {
      await renameDirectory(staging, destination);
      stagingExists = false;
    } catch (publishError) {
      if (backupExists) {
        try {
          await renameDirectory(backup, destination);
          backupExists = false;
        } catch (restoreError) {
          throw new AggregateError(
            [publishError, restoreError],
            `Failed to publish ${destination}; previous output remains at ${backup}`,
          );
        }
      }
      throw publishError;
    }

    if (backupExists) {
      await removeDirectory(backup);
      backupExists = false;
    }
  } catch (error) {
    failures.push(error);
  }

  if (stagingExists) {
    try {
      await removeDirectory(staging);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Failed to replace ${destination} and clean its staging directory ${staging}`,
    );
  }
  if (failures.length === 1) throw failures[0];
};
