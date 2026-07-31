import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { Data, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ArtifactManifestEntry = {
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
  readonly mode: "file" | "executable";
};

export type ArtifactManifest = {
  readonly contract: "zeroy/theme-manifest@1" | "zeroy/site-logic-manifest@1";
  readonly entries: ReadonlyArray<ArtifactManifestEntry>;
};

export type ArtifactPolicy = {
  readonly contract: string;
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxStorageBytes: number;
  readonly allowSymlinks: false;
};

export type SiteWorkspaceMetadata = {
  readonly checkoutId: string;
  readonly siteId: string;
  readonly baseReleaseId: string;
  readonly baseThemeArtifactId: string;
  readonly baseSiteLogicArtifactId: string;
  readonly localPath: string;
  readonly themePolicy: ArtifactPolicy;
  readonly siteLogicPolicy: ArtifactPolicy;
};

export type SiteWorkspaceStatus = SiteWorkspaceMetadata & {
  readonly head: string | null;
  readonly dirty: boolean;
};

export type PreparedSitePush = {
  readonly checkout: SiteWorkspaceMetadata;
  readonly sourceCommit: string;
  readonly theme: { readonly manifest: ArtifactManifest; readonly archiveBase64: string };
  readonly siteLogic: { readonly manifest: ArtifactManifest; readonly archiveBase64: string };
};

export class SiteWorkspaceError extends Data.TaggedError("SiteWorkspaceError")<{
  readonly operation: string;
  readonly message: string;
}> {}

type Runtime = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
type Subtree = {
  readonly directory: "theme" | "site-logic";
  readonly contract: ArtifactManifest["contract"];
  readonly policy: ArtifactPolicy;
};

const themeSubtree = (policy: ArtifactPolicy): Subtree => ({
  directory: "theme",
  contract: "zeroy/theme-manifest@1",
  policy,
});
const logicSubtree = (policy: ArtifactPolicy): Subtree => ({
  directory: "site-logic",
  contract: "zeroy/site-logic-manifest@1",
  policy,
});
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};
const operation = <A, R>(name: string, effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof SiteWorkspaceError
        ? cause
        : new SiteWorkspaceError({ operation: name, message: String(cause) }),
    ),
  );
const workspaceRoot = (path: Path.Path, siteId: string, checkoutId: string): string =>
  path.join(homedir(), ".pipee", "zeroy", "site-workspaces", siteId, checkoutId);
const collectionRoot = (path: Path.Path): string =>
  path.join(homedir(), ".pipee", "zeroy", "site-workspaces");
const validPath = (value: string): boolean =>
  value !== "" &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const forbidden = (value: string): boolean =>
  value === ".DS_Store" ||
  value.endsWith("/.DS_Store") ||
  value.endsWith(".log") ||
  /(^|\/)(\.git|node_modules|\.cache|\.tmp|coverage)(\/|$)/.test(value);

const command = (
  binary: string,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, SiteWorkspaceError, ChildProcessSpawner.ChildProcessSpawner> =>
  operation(
    `${binary} ${args[0] ?? ""}`.trim(),
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(binary, args, {
          cwd,
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, status] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.runCollect, Effect.map(concatenate)),
            child.stderr.pipe(Stream.runCollect, Effect.map(concatenate)),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(status) !== 0) {
          return yield* new SiteWorkspaceError({
            operation: `${binary} ${args[0] ?? ""}`.trim(),
            message: decode(stderr).trim() || `${binary} exited with ${Number(status)}.`,
          });
        }
        return stdout;
      }),
    ),
  );
const git = (cwd: string, args: ReadonlyArray<string>) => command("git", cwd, args);

const decodeMetadata = (raw: string): Effect.Effect<SiteWorkspaceMetadata, SiteWorkspaceError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () =>
      new SiteWorkspaceError({
        operation: "workspace.metadata.decode",
        message: "Site workspace metadata is not valid JSON.",
      }),
  }).pipe(
    Effect.flatMap((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        ![
          "checkoutId",
          "siteId",
          "baseReleaseId",
          "baseThemeArtifactId",
          "baseSiteLogicArtifactId",
          "localPath",
        ].every((field) => typeof (value as Record<string, unknown>)[field] === "string")
      ) {
        return Effect.fail(
          new SiteWorkspaceError({
            operation: "workspace.metadata.decode",
            message: "Site workspace metadata has an invalid shape.",
          }),
        );
      }
      return Effect.succeed(value as SiteWorkspaceMetadata);
    }),
  );

const readMetadata = (
  checkoutId: string,
): Effect.Effect<SiteWorkspaceMetadata, SiteWorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = collectionRoot(path);
    if (!(yield* operation("workspace.metadata.exists", fs.exists(root)))) {
      return yield* new SiteWorkspaceError({
        operation: "workspace.metadata.read",
        message: `Unknown zeroY checkoutId: ${checkoutId}`,
      });
    }
    for (const site of yield* operation("workspace.metadata.sites", fs.readDirectory(root))) {
      const candidate = path.join(root, site, checkoutId, "metadata.json");
      if (!(yield* operation("workspace.metadata.candidate", fs.exists(candidate)))) continue;
      return yield* operation(
        "workspace.metadata.read",
        fs.readFileString(candidate).pipe(Effect.flatMap(decodeMetadata)),
      );
    }
    return yield* new SiteWorkspaceError({
      operation: "workspace.metadata.read",
      message: `Unknown zeroY checkoutId: ${checkoutId}`,
    });
  });

const manifestFromHead = (
  root: string,
  subtree: Subtree,
): Effect.Effect<ArtifactManifest, SiteWorkspaceError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const prefix = `${subtree.directory}/`;
    const rows = decode(yield* git(root, ["ls-tree", "-r", "-z", "HEAD", "--", subtree.directory]))
      .split("\0")
      .filter(Boolean);
    const entries: ArtifactManifestEntry[] = [];
    let total = 0;
    for (const row of rows) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(row);
      if (!match)
        return yield* new SiteWorkspaceError({
          operation: "workspace.manifest.tree",
          message: `Git HEAD has an unreadable entry: ${row}`,
        });
      const [, mode, type, objectId, fullPath] = match;
      const entryPath = fullPath?.startsWith(prefix) ? fullPath.slice(prefix.length) : "";
      if (
        !mode ||
        type !== "blob" ||
        !objectId ||
        !entryPath ||
        mode === "120000" ||
        !validPath(entryPath) ||
        forbidden(entryPath)
      ) {
        return yield* new SiteWorkspaceError({
          operation: "workspace.manifest.policy",
          message: `Git HEAD contains a forbidden ${subtree.directory} entry: ${fullPath}`,
        });
      }
      const content = yield* git(root, ["cat-file", "blob", objectId]);
      total += content.length;
      if (
        content.length > subtree.policy.maxFileBytes ||
        total > subtree.policy.maxArtifactBytes ||
        entries.length + 1 > subtree.policy.maxFiles
      ) {
        return yield* new SiteWorkspaceError({
          operation: "workspace.manifest.policy",
          message: `${subtree.directory} exceeds artifact policy.`,
        });
      }
      entries.push({
        path: entryPath,
        hash: hash(content),
        bytes: content.length,
        mode: mode === "100755" ? "executable" : "file",
      });
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    if (entries.length === 0)
      return yield* new SiteWorkspaceError({
        operation: "workspace.manifest.tree",
        message: `${subtree.directory} has no tracked files.`,
      });
    return { contract: subtree.contract, entries };
  });

const archiveFromHead = (
  root: string,
  subtree: Subtree,
): Effect.Effect<string, SiteWorkspaceError, ChildProcessSpawner.ChildProcessSpawner> =>
  git(root, ["archive", "--format=tar.gz", `HEAD:${subtree.directory}`]).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64")),
  );

const verifyExtracted = (
  directory: string,
  manifest: ArtifactManifest,
): Effect.Effect<void, SiteWorkspaceError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const entry of manifest.entries) {
      const bytes = yield* operation(
        "workspace.extract.read",
        fs.readFile(path.join(directory, entry.path)),
      );
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.hash) {
        return yield* new SiteWorkspaceError({
          operation: "workspace.extract.verify",
          message: `Downloaded Artifact does not match manifest at ${entry.path}.`,
        });
      }
    }
  });

export const createSiteWorkspace = (input: {
  readonly siteId: string;
  readonly releaseId: string;
  readonly themeArtifactId: string;
  readonly siteLogicArtifactId: string;
  readonly theme: {
    readonly manifest: ArtifactManifest;
    readonly archiveBase64: string;
    readonly policy: ArtifactPolicy;
  };
  readonly siteLogic: {
    readonly manifest: ArtifactManifest;
    readonly archiveBase64: string;
    readonly policy: ArtifactPolicy;
  };
}): Effect.Effect<SiteWorkspaceMetadata & { readonly head: string }, SiteWorkspaceError, Runtime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkoutId = randomUUID();
      const root = workspaceRoot(path, input.siteId, checkoutId);
      const stage = yield* operation(
        "workspace.stage",
        fs.makeTempDirectoryScoped({ prefix: "zeroy-site-workspace-" }),
      );
      const extract = (
        subtree: Subtree,
        value: { readonly manifest: ArtifactManifest; readonly archiveBase64: string },
      ) =>
        Effect.gen(function* () {
          const destination = path.join(root, subtree.directory);
          yield* operation(
            "workspace.directory",
            fs.makeDirectory(destination, { recursive: true }),
          );
          const archive = path.join(stage, `${subtree.directory}.tar.gz`);
          yield* operation(
            "workspace.archive",
            fs.writeFile(archive, Buffer.from(value.archiveBase64, "base64")),
          );
          yield* command("tar", stage, ["-xzf", archive, "-C", destination]);
          yield* verifyExtracted(destination, value.manifest);
        });
      yield* operation("workspace.root", fs.makeDirectory(root, { recursive: true }));
      yield* extract(themeSubtree(input.theme.policy), input.theme);
      yield* extract(logicSubtree(input.siteLogic.policy), input.siteLogic);
      yield* git(root, ["init"]);
      yield* git(root, ["add", "-A"]);
      yield* git(root, [
        "-c",
        "user.name=zeroY",
        "-c",
        "user.email=zeroy@local",
        "commit",
        "-m",
        `zeroY SiteRelease ${input.releaseId}`,
      ]);
      yield* operation(
        "workspace.metadata.exclude",
        fs.writeFileString(path.join(root, ".git", "info", "exclude"), "metadata.json\n"),
      );
      const metadata: SiteWorkspaceMetadata = {
        checkoutId,
        siteId: input.siteId,
        baseReleaseId: input.releaseId,
        baseThemeArtifactId: input.themeArtifactId,
        baseSiteLogicArtifactId: input.siteLogicArtifactId,
        localPath: root,
        themePolicy: input.theme.policy,
        siteLogicPolicy: input.siteLogic.policy,
      };
      yield* operation(
        "workspace.metadata",
        fs.writeFileString(path.join(root, "metadata.json"), JSON.stringify(metadata, null, 2)),
      );
      const head = decode(yield* git(root, ["rev-parse", "HEAD"])).trim();
      return { ...metadata, head };
    }),
  );

export const prepareSitePush = (
  checkoutId: string,
): Effect.Effect<PreparedSitePush, SiteWorkspaceError, Runtime> =>
  Effect.gen(function* () {
    const checkout = yield* readMetadata(checkoutId);
    const dirty = decode(yield* git(checkout.localPath, ["status", "--porcelain"])).trim();
    if (dirty !== "")
      return yield* new SiteWorkspaceError({
        operation: "workspace.push.clean",
        message: "Site workspace has uncommitted changes; commit them before push.",
      });
    const sourceCommit = decode(yield* git(checkout.localPath, ["rev-parse", "HEAD"])).trim();
    const theme = themeSubtree(checkout.themePolicy);
    const siteLogic = logicSubtree(checkout.siteLogicPolicy);
    return {
      checkout,
      sourceCommit,
      theme: {
        manifest: yield* manifestFromHead(checkout.localPath, theme),
        archiveBase64: yield* archiveFromHead(checkout.localPath, theme),
      },
      siteLogic: {
        manifest: yield* manifestFromHead(checkout.localPath, siteLogic),
        archiveBase64: yield* archiveFromHead(checkout.localPath, siteLogic),
      },
    };
  });

export const listSiteWorkspaces = (
  siteId: string,
): Effect.Effect<ReadonlyArray<SiteWorkspaceStatus>, SiteWorkspaceError, Runtime> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(collectionRoot(path), siteId);
    if (!(yield* operation("workspace.list.exists", fs.exists(root)))) return [];
    const statuses = yield* Effect.forEach(
      yield* operation("workspace.list.directory", fs.readDirectory(root)),
      (checkoutId) =>
        Effect.gen(function* () {
          const metadata = yield* readMetadata(checkoutId);
          if (metadata.siteId !== siteId)
            return yield* new SiteWorkspaceError({
              operation: "workspace.list.owner",
              message: "Workspace belongs to another site.",
            });
          return {
            ...metadata,
            dirty: decode(yield* git(metadata.localPath, ["status", "--porcelain"])).trim() !== "",
            head: decode(yield* git(metadata.localPath, ["rev-parse", "HEAD"])).trim() || null,
          };
        }),
      { concurrency: 4 },
    );
    return statuses.sort((left, right) =>
      Buffer.compare(Buffer.from(left.checkoutId), Buffer.from(right.checkoutId)),
    );
  });

export const prepareSiteSeed = (input: {
  readonly themeSourceDirectory: string;
  readonly siteLogicSourceDirectory: string;
  readonly themePolicy: ArtifactPolicy;
  readonly siteLogicPolicy: ArtifactPolicy;
}): Effect.Effect<Omit<PreparedSitePush, "checkout">, SiteWorkspaceError, Runtime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* operation(
        "seed.stage",
        fs.makeTempDirectoryScoped({ prefix: "zeroy-site-seed-" }),
      );
      yield* operation("seed.theme", fs.copy(input.themeSourceDirectory, path.join(root, "theme")));
      yield* operation(
        "seed.logic",
        fs.copy(input.siteLogicSourceDirectory, path.join(root, "site-logic")),
      );
      yield* git(root, ["init"]);
      yield* git(root, ["add", "-A"]);
      yield* git(root, [
        "-c",
        "user.name=zeroY",
        "-c",
        "user.email=zeroy@local",
        "commit",
        "-m",
        "zeroY SiteRelease bootstrap seed",
      ]);
      const sourceCommit = decode(yield* git(root, ["rev-parse", "HEAD"])).trim();
      const theme = themeSubtree(input.themePolicy);
      const siteLogic = logicSubtree(input.siteLogicPolicy);
      return {
        sourceCommit,
        theme: {
          manifest: yield* manifestFromHead(root, theme),
          archiveBase64: yield* archiveFromHead(root, theme),
        },
        siteLogic: {
          manifest: yield* manifestFromHead(root, siteLogic),
          archiveBase64: yield* archiveFromHead(root, siteLogic),
        },
      };
    }),
  );
