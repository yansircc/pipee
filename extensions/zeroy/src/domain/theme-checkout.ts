import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Buffer } from "node:buffer";
import { Data, Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ThemeManifestEntry = {
  readonly path: string;
  readonly hash: string;
  readonly bytes: number;
  readonly mode: "file" | "executable";
};

export type ThemeManifest = {
  readonly contract: "zeroy/theme-manifest@1";
  readonly entries: ReadonlyArray<ThemeManifestEntry>;
};

export type ThemePolicy = {
  readonly contract: "zeroy/theme-artifact-policy@1";
  readonly forbiddenPaths: ReadonlyArray<string>;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxArtifactBytes: number;
  readonly maxStorageBytes: number;
  readonly allowSymlinks: false;
};

export type ThemeCheckoutMetadata = {
  readonly checkoutId: string;
  readonly siteId: string;
  readonly baseArtifactId: string;
  readonly baseDeploymentId: string;
  readonly localPath: string;
  readonly policy: ThemePolicy;
};

export type PreparedThemePush = {
  readonly checkout: ThemeCheckoutMetadata;
  readonly sourceCommit: string;
  readonly manifest: ThemeManifest;
  readonly archiveBase64: string;
};

export type PreparedThemeSeed = {
  readonly sourceCommit: string;
  readonly manifest: ThemeManifest;
  readonly archiveBase64: string;
};

export type ThemeCheckoutStatus = ThemeCheckoutMetadata & {
  readonly head: string | null;
  readonly dirty: boolean;
};

export class ThemeCheckoutError extends Data.TaggedError("ThemeCheckoutError")<{
  readonly operation: string;
  readonly message: string;
}> {}

type CheckoutRuntime = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const checkoutDirectory = ".pipee";
const checkoutNamespace = "zeroy";
const checkoutCollection = "checkouts";

const text = (value: unknown): string => JSON.stringify(value, null, 2);
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const artifactId = (manifest: ThemeManifest): string =>
  `sha256:${hash(new TextEncoder().encode(JSON.stringify(manifest)))}`;
const decodeText = (value: Uint8Array): string => new TextDecoder().decode(value);
const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
const operation = <A, R>(name: string, effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      cause instanceof ThemeCheckoutError
        ? cause
        : new ThemeCheckoutError({ operation: name, message: String(cause) }),
    ),
  );

const forbidden = (path: string): boolean =>
  path === ".DS_Store" ||
  path.endsWith("/.DS_Store") ||
  path.endsWith(".log") ||
  /(^|\/)(\.git|node_modules|\.cache|\.tmp|coverage)(\/|$)/.test(path);

const validPath = (path: string): boolean =>
  path !== "" &&
  !path.includes("\0") &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const checkoutRoot = (path: Path.Path, siteId: string, checkoutId: string): string =>
  path.join(
    homedir(),
    checkoutDirectory,
    checkoutNamespace,
    checkoutCollection,
    siteId,
    checkoutId,
  );

const checkoutCollectionRoot = (path: Path.Path): string =>
  path.join(homedir(), checkoutDirectory, checkoutNamespace, checkoutCollection);

const runCommand = (
  command: string,
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, ThemeCheckoutError, ChildProcessSpawner.ChildProcessSpawner> =>
  operation(
    `${command} ${args[0] ?? ""}`.trim(),
    Effect.scoped(
      Effect.gen(function* () {
        const child = yield* ChildProcess.make(command, args, {
          cwd,
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.runCollect, Effect.map(concatenate)),
            child.stderr.pipe(Stream.runCollect, Effect.map(concatenate)),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(exitCode) !== 0) {
          return yield* new ThemeCheckoutError({
            operation: `${command} ${args[0] ?? ""}`.trim(),
            message: decodeText(stderr).trim() || `${command} exited with ${Number(exitCode)}.`,
          });
        }
        return stdout;
      }),
    ),
  ).pipe(Effect.withSpan("zeroy.theme-checkout.command"));

const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, ThemeCheckoutError, ChildProcessSpawner.ChildProcessSpawner> =>
  runCommand("git", cwd, args);

const decodeMetadata = (raw: string): Effect.Effect<ThemeCheckoutMetadata, ThemeCheckoutError> =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () =>
      new ThemeCheckoutError({
        operation: "checkout.metadata.decode",
        message: "Theme checkout metadata is not valid JSON.",
      }),
  }).pipe(
    Effect.flatMap((parsed) => {
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).checkoutId !== "string" ||
        typeof (parsed as Record<string, unknown>).siteId !== "string" ||
        typeof (parsed as Record<string, unknown>).baseArtifactId !== "string" ||
        typeof (parsed as Record<string, unknown>).baseDeploymentId !== "string" ||
        typeof (parsed as Record<string, unknown>).localPath !== "string" ||
        typeof (parsed as Record<string, unknown>).policy !== "object" ||
        (parsed as Record<string, unknown>).policy === null
      ) {
        return Effect.fail(
          new ThemeCheckoutError({
            operation: "checkout.metadata.decode",
            message: "Theme checkout metadata has an invalid shape.",
          }),
        );
      }
      return Effect.succeed(parsed as ThemeCheckoutMetadata);
    }),
  );

const readMetadata = (
  checkoutId: string,
): Effect.Effect<ThemeCheckoutMetadata, ThemeCheckoutError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = checkoutCollectionRoot(path);
    if (!(yield* operation("checkout.metadata.root", fs.exists(root)))) {
      return yield* new ThemeCheckoutError({
        operation: "checkout.metadata.read",
        message: `Unknown zeroY checkoutId: ${checkoutId}`,
      });
    }
    const sites = yield* operation("checkout.metadata.list", fs.readDirectory(root));
    for (const site of sites) {
      const sitePath = path.join(root, site);
      const info = yield* operation("checkout.metadata.stat", fs.stat(sitePath));
      if (info.type !== "Directory") continue;
      const metadataPath = path.join(sitePath, checkoutId, "metadata.json");
      if (!(yield* operation("checkout.metadata.exists", fs.exists(metadataPath)))) continue;
      return yield* operation(
        "checkout.metadata.read",
        fs.readFileString(metadataPath).pipe(Effect.flatMap(decodeMetadata)),
      );
    }
    return yield* new ThemeCheckoutError({
      operation: "checkout.metadata.read",
      message: `Unknown zeroY checkoutId: ${checkoutId}`,
    });
  }).pipe(Effect.withSpan("zeroy.theme-checkout.metadata.read"));

export const listThemeCheckouts = (
  siteId: string,
): Effect.Effect<ReadonlyArray<ThemeCheckoutStatus>, ThemeCheckoutError, CheckoutRuntime> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(checkoutCollectionRoot(path), siteId);
    if (!(yield* operation("checkout.list.root", fs.exists(root)))) return [];
    const ids = yield* operation("checkout.list.directory", fs.readDirectory(root));
    const checkouts = yield* Effect.forEach(
      ids,
      (checkoutId) =>
        Effect.gen(function* () {
          const metadataPath = path.join(root, checkoutId, "metadata.json");
          const metadata = yield* operation(
            "checkout.list.metadata",
            fs.readFileString(metadataPath).pipe(Effect.flatMap(decodeMetadata)),
          );
          if (metadata.siteId !== siteId || metadata.checkoutId !== checkoutId) {
            return yield* new ThemeCheckoutError({
              operation: "checkout.list.metadata",
              message: `Theme checkout metadata does not belong to ${siteId}.`,
            });
          }
          const dirty = decodeText(
            yield* runGit(metadata.localPath, ["status", "--porcelain"]),
          ).trim();
          const head = decodeText(yield* runGit(metadata.localPath, ["rev-parse", "HEAD"])).trim();
          return { ...metadata, dirty: dirty !== "", head: head || null };
        }),
      { concurrency: 4 },
    );
    return checkouts.sort((left, right) =>
      Buffer.compare(Buffer.from(left.checkoutId), Buffer.from(right.checkoutId)),
    );
  }).pipe(Effect.withSpan("zeroy.theme-checkout.list"));

const writePolicyExclude = (
  theme: string,
  policy: ThemePolicy,
): Effect.Effect<void, ThemeCheckoutError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = path.join(theme, ".git", "info");
    yield* operation("checkout.exclude.directory", fs.makeDirectory(info, { recursive: true }));
    yield* operation(
      "checkout.exclude.write",
      fs.writeFileString(path.join(info, "exclude"), `${policy.forbiddenPaths.join("\n")}\n`),
    );
  });

const verifyManifestTree = (
  theme: string,
  manifest: ThemeManifest,
): Effect.Effect<void, ThemeCheckoutError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    const actual = new Map<string, ThemeManifestEntry>();
    const visit = (
      directory: string,
    ): Effect.Effect<void, ThemeCheckoutError, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        const children = yield* operation("checkout.verify.list", fs.readDirectory(directory));
        yield* Effect.forEach(
          children,
          (name) =>
            Effect.gen(function* () {
              const absolute = path.join(directory, name);
              const relativePath = path.relative(theme, absolute).split(path.sep).join("/");
              const info = yield* operation("checkout.verify.stat", fs.stat(absolute));
              if (info.type === "Directory") return yield* visit(absolute);
              if (info.type !== "File") {
                return yield* new ThemeCheckoutError({
                  operation: "checkout.verify.entry",
                  message: `ThemeArtifact checkout contains a non-regular entry: ${relativePath}`,
                });
              }
              const bytes = yield* operation("checkout.verify.read", fs.readFile(absolute));
              actual.set(relativePath, {
                path: relativePath,
                hash: hash(bytes),
                bytes: bytes.length,
                mode: (info.mode & 0o111) !== 0 ? "executable" : "file",
              });
            }),
          { concurrency: 8, discard: true },
        );
      });
    yield* visit(theme);
    if (actual.size !== expected.size) {
      return yield* new ThemeCheckoutError({
        operation: "checkout.verify.manifest",
        message: "ThemeArtifact checkout file count does not match manifest.",
      });
    }
    for (const [entryPath, entry] of expected) {
      const observed = actual.get(entryPath);
      if (
        observed === undefined ||
        observed.hash !== entry.hash ||
        observed.bytes !== entry.bytes ||
        observed.mode !== entry.mode
      ) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.verify.manifest",
          message: `ThemeArtifact checkout does not match manifest at ${entryPath}.`,
        });
      }
    }
  }).pipe(Effect.withSpan("zeroy.theme-checkout.verify"));

export const createThemeCheckout = (input: {
  readonly siteId: string;
  readonly artifactId: string;
  readonly deploymentId: string;
  readonly manifest: ThemeManifest;
  readonly archiveBase64: string;
  readonly policy: ThemePolicy;
}): Effect.Effect<
  ThemeCheckoutMetadata & { readonly head: string },
  ThemeCheckoutError,
  CheckoutRuntime
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkoutId = randomUUID();
      const root = checkoutRoot(path, input.siteId, checkoutId);
      const theme = path.join(root, "theme");
      const stage = yield* operation(
        "checkout.stage.create",
        fs.makeTempDirectoryScoped({ prefix: "zeroy-checkout-" }),
      );
      const create = Effect.gen(function* () {
        if (artifactId(input.manifest) !== input.artifactId) {
          return yield* new ThemeCheckoutError({
            operation: "checkout.manifest.identity",
            message: "ThemeArtifact manifest does not match the requested artifactId.",
          });
        }
        yield* operation("checkout.theme.create", fs.makeDirectory(theme, { recursive: true }));
        const archive = path.join(stage, "artifact.tar.gz");
        yield* operation(
          "checkout.archive.write",
          fs.writeFile(archive, Buffer.from(input.archiveBase64, "base64")),
        );
        yield* runCommand("tar", stage, ["-xzf", archive, "-C", theme]);
        yield* verifyManifestTree(theme, input.manifest);
        yield* runGit(theme, ["init"]);
        yield* runGit(theme, ["add", "-A"]);
        yield* runGit(theme, [
          "-c",
          "user.name=zeroY",
          "-c",
          "user.email=zeroy@local",
          "commit",
          "-m",
          `zeroY artifact ${input.artifactId}`,
        ]);
        yield* writePolicyExclude(theme, input.policy);
        const metadata: ThemeCheckoutMetadata = {
          checkoutId,
          siteId: input.siteId,
          baseArtifactId: input.artifactId,
          baseDeploymentId: input.deploymentId,
          localPath: theme,
          policy: input.policy,
        };
        yield* operation(
          "checkout.metadata.write",
          fs.writeFileString(path.join(root, "metadata.json"), text(metadata)),
        );
        const head = decodeText(yield* runGit(theme, ["rev-parse", "HEAD"])).trim();
        return { ...metadata, head };
      });
      return yield* create.pipe(
        Effect.onError(() =>
          operation("checkout.cleanup", fs.remove(root, { recursive: true, force: true })).pipe(
            Effect.ignore,
          ),
        ),
      );
    }),
  );

const manifestFromHead = (
  theme: string,
  policy: ThemePolicy,
): Effect.Effect<ThemeManifest, ThemeCheckoutError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const rows = decodeText(yield* runGit(theme, ["ls-tree", "-r", "-z", "HEAD"]))
      .split("\0")
      .filter(Boolean);
    const entries: ThemeManifestEntry[] = [];
    let total = 0;
    for (const row of rows) {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(row);
      if (!match) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.manifest.tree",
          message: `Git HEAD has an unreadable tree entry: ${row}`,
        });
      }
      const [, mode, type, objectId, entryPath] = match;
      if (!mode || !type || !objectId || !entryPath) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.manifest.tree",
          message: `Git HEAD has an incomplete tree entry: ${row}`,
        });
      }
      if (type !== "blob" || mode === "120000" || !validPath(entryPath) || forbidden(entryPath)) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.manifest.policy",
          message: `Git HEAD contains a forbidden ThemeArtifact entry: ${entryPath}`,
        });
      }
      const content = yield* runGit(theme, ["cat-file", "blob", objectId]);
      if (content.length > policy.maxFileBytes) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.manifest.policy",
          message: `ThemeArtifact file exceeds policy: ${entryPath}`,
        });
      }
      total += content.length;
      if (total > policy.maxArtifactBytes || entries.length + 1 > policy.maxFiles) {
        return yield* new ThemeCheckoutError({
          operation: "checkout.manifest.policy",
          message: "Git HEAD exceeds ThemeArtifact policy.",
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
    if (entries.length === 0) {
      return yield* new ThemeCheckoutError({
        operation: "checkout.manifest.tree",
        message: "Git HEAD contains no ThemeArtifact files.",
      });
    }
    return { contract: "zeroy/theme-manifest@1" as const, entries };
  }).pipe(Effect.withSpan("zeroy.theme-checkout.manifest"));

export const prepareThemePush = (
  checkoutId: string,
): Effect.Effect<PreparedThemePush, ThemeCheckoutError, CheckoutRuntime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const checkout = yield* readMetadata(checkoutId);
      const dirty = decodeText(yield* runGit(checkout.localPath, ["status", "--porcelain"])).trim();
      if (dirty !== "") {
        return yield* new ThemeCheckoutError({
          operation: "checkout.push.clean",
          message: "Theme checkout has uncommitted changes; commit them before push.",
        });
      }
      const sourceCommit = decodeText(
        yield* runGit(checkout.localPath, ["rev-parse", "HEAD"]),
      ).trim();
      const manifest = yield* manifestFromHead(checkout.localPath, checkout.policy);
      const stage = yield* operation(
        "checkout.push.stage",
        fs.makeTempDirectoryScoped({ prefix: "zeroy-push-" }),
      );
      const archive = path.join(stage, "artifact.tar.gz");
      yield* runGit(checkout.localPath, [
        "archive",
        "--format=tar.gz",
        `--output=${archive}`,
        "HEAD",
      ]);
      const archiveBytes = yield* operation("checkout.push.archive", fs.readFile(archive));
      return {
        checkout,
        sourceCommit,
        manifest,
        archiveBase64: Buffer.from(archiveBytes).toString("base64"),
      };
    }),
  ).pipe(Effect.withSpan("zeroy.theme-checkout.push.prepare"));

/**
 * The bundled seed is treated exactly like any other local Git tree before it
 * can cross the Connector boundary. It exists only for a one-time bootstrap;
 * the durable checkout is always re-materialized from the active Artifact.
 */
export const prepareThemeSeed = (input: {
  readonly sourceDirectory: string;
  readonly policy: ThemePolicy;
}): Effect.Effect<PreparedThemeSeed, ThemeCheckoutError, CheckoutRuntime> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stage = yield* operation(
        "bootstrap.seed.stage",
        fs.makeTempDirectoryScoped({ prefix: "zeroy-theme-seed-" }),
      );
      const theme = path.join(stage, "theme");
      yield* operation("bootstrap.seed.copy", fs.copy(input.sourceDirectory, theme));
      yield* runGit(theme, ["init"]);
      yield* runGit(theme, ["add", "-A"]);
      yield* runGit(theme, [
        "-c",
        "user.name=zeroY",
        "-c",
        "user.email=zeroy@local",
        "commit",
        "-m",
        "zeroY bootstrap seed",
      ]);
      const sourceCommit = decodeText(yield* runGit(theme, ["rev-parse", "HEAD"])).trim();
      const manifest = yield* manifestFromHead(theme, input.policy);
      const archive = path.join(stage, "artifact.tar.gz");
      yield* runGit(theme, ["archive", "--format=tar.gz", `--output=${archive}`, "HEAD"]);
      const archiveBytes = yield* operation("bootstrap.seed.archive", fs.readFile(archive));
      return {
        sourceCommit,
        manifest,
        archiveBase64: Buffer.from(archiveBytes).toString("base64"),
      };
    }),
  ).pipe(Effect.withSpan("zeroy.theme-bootstrap.seed.prepare"));

export const manifestIdentity = artifactId;
