import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ScreenshotFailure } from "../core/errors.js";
import { screenshotResultSchemaFor } from "../protocol/operation-contract.js";
import type { PageCall } from "../protocol/schema.js";
import { rollbackStagingOnFailure } from "./rollback-staging.js";

type ScreenshotOperation = Extract<PageCall["operation"], { readonly kind: "screenshot" }>;
type ScreenshotFormat = ScreenshotOperation["format"];
type ScreenshotDimensions = {
  readonly width: number;
  readonly height: number;
  readonly viewportHeight: number;
  readonly dpr: number;
};

export type SavedScreenshot = {
  readonly text: string;
  readonly value:
    | {
        readonly kind: "image";
        readonly path: string;
        readonly format: ScreenshotFormat;
      }
    | {
        readonly kind: "tile-set";
        readonly directory: string;
        readonly format: ScreenshotFormat;
        readonly manifestPath: string;
        readonly tiles: ReadonlyArray<{ readonly path: string; readonly y: number }>;
        readonly dimensions: ScreenshotDimensions;
      };
};

const fail = (message: string, cause?: unknown) => new ScreenshotFailure({ message, cause });

const decodeDataUrl = (value: string, format: ScreenshotFormat) =>
  Effect.gen(function* () {
    const prefix = `data:image/${format};base64,`;
    if (!value.startsWith(prefix)) {
      return yield* fail(`Screenshot response MIME does not match requested ${format}`);
    }
    const bytes = Buffer.from(value.slice(prefix.length), "base64");
    if (bytes.length === 0) return yield* fail("Screenshot response contains no image bytes");
    return bytes;
  });

const within = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
};

const validateWorkspaceRelativePath = (
  path: Path.Path,
  candidate: string,
  label: string,
): Effect.Effect<string, ScreenshotFailure> => {
  const segments = candidate.split("/");
  return path.isAbsolute(candidate) ||
    /^[A-Za-z]:[\\/]/.test(candidate) ||
    candidate.includes("\\") ||
    candidate.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? Effect.fail(fail(`${label} must be a normalized workspace-relative path`))
    : Effect.succeed(candidate);
};

const nearestExistingAncestor = (fs: FileSystem.FileSystem, path: Path.Path, candidate: string) =>
  Effect.gen(function* () {
    let current = candidate;
    while (!(yield* fs.exists(current))) {
      const parent = path.dirname(current);
      if (parent === current) return yield* fail("Screenshot target has no existing ancestor");
      current = parent;
    }
    return current;
  });

const prepareWorkspaceDestination = (
  cwd: string,
  relativePath: string,
): Effect.Effect<string, ScreenshotFailure | PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relative = yield* validateWorkspaceRelativePath(path, relativePath, "Screenshot target");
    const workspace = yield* fs.realPath(cwd);
    const lexicalTarget = path.resolve(workspace, ...relative.split("/"));
    if (!within(path, workspace, lexicalTarget)) {
      return yield* fail("Screenshot target resolves outside the workspace");
    }

    const ancestor = yield* nearestExistingAncestor(fs, path, lexicalTarget);
    const realAncestor = yield* fs.realPath(ancestor);
    if (!within(path, workspace, realAncestor)) {
      return yield* fail("Screenshot target escapes the workspace through a symbolic link");
    }

    const parent = path.dirname(lexicalTarget);
    yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
    const realParent = yield* fs.realPath(parent);
    if (!within(path, workspace, realParent)) {
      return yield* fail("Screenshot target parent escapes the workspace through a symbolic link");
    }
    return path.join(realParent, path.basename(lexicalTarget));
  });

const imageRelativePath = (
  path: Path.Path,
  operation: ScreenshotOperation,
  generatedStem: string,
): Effect.Effect<string, ScreenshotFailure> => {
  if (operation.capture.kind !== "viewport") {
    return Effect.fail(fail("Image artifact requires a viewport capture"));
  }
  const requested = operation.capture.path ?? `${generatedStem}.${operation.format}`;
  const extension = path.extname(requested);
  if (extension === "") return Effect.succeed(`${requested}.${operation.format}`);
  return extension === `.${operation.format}`
    ? Effect.succeed(requested)
    : Effect.fail(
        fail(`Screenshot path extension ${extension} does not match requested ${operation.format}`),
      );
};

const removeStaging = (fs: FileSystem.FileSystem, staging: string, recursive: boolean) =>
  fs
    .remove(staging, { force: true, recursive })
    .pipe(
      Effect.mapError((cause) =>
        fail(`Could not remove screenshot staging artifact ${staging}`, cause),
      ),
    );

const publishImage = (
  cwd: string,
  operation: ScreenshotOperation,
  bytes: Uint8Array,
  generatedStem: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relativePath = yield* imageRelativePath(path, operation, generatedStem);
    const destination = yield* prepareWorkspaceDestination(cwd, relativePath);
    const staging = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.staging-${globalThis.crypto.randomUUID()}`,
    );
    return yield* rollbackStagingOnFailure(
      Effect.gen(function* () {
        yield* fs.writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
        yield* fs.chmod(staging, 0o600);
        const saved = {
          text: `Saved Chrome screenshot image to ${destination}`,
          value: { kind: "image", path: destination, format: operation.format },
        } satisfies SavedScreenshot;
        yield* fs.rename(staging, destination);
        return saved;
      }),
      removeStaging(fs, staging, false),
    );
  });

const publishTileSet = (
  cwd: string,
  operation: ScreenshotOperation,
  result: {
    readonly dimensions: ScreenshotDimensions;
    readonly tiles: ReadonlyArray<{ readonly y: number; readonly bytes: Uint8Array }>;
  },
  generatedStem: string,
) =>
  Effect.gen(function* () {
    if (operation.capture.kind !== "full-page-tiles") {
      return yield* fail("Tile-set artifact requires a full-page-tiles capture");
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const relativeDirectory = operation.capture.directory ?? `${generatedStem}-tiles`;
    const destination = yield* prepareWorkspaceDestination(cwd, relativeDirectory);
    if (yield* fs.exists(destination)) {
      return yield* fail(`Screenshot tile-set destination already exists: ${destination}`);
    }

    const staging = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.staging-${globalThis.crypto.randomUUID()}`,
    );
    return yield* rollbackStagingOnFailure(
      Effect.gen(function* () {
        yield* fs.makeDirectory(staging, { mode: 0o700 });
        yield* fs.chmod(staging, 0o700);
        const manifestTiles = yield* Effect.forEach(result.tiles, (tile, index) => {
          const file = `tile-${String(index).padStart(4, "0")}.${operation.format}`;
          const tilePath = path.join(staging, file);
          return Effect.gen(function* () {
            yield* fs.writeFile(tilePath, tile.bytes, { flag: "wx", mode: 0o600 });
            yield* fs.chmod(tilePath, 0o600);
            return { file, y: tile.y };
          });
        });
        const manifest = {
          version: 1,
          kind: "tile-set",
          format: operation.format,
          dimensions: result.dimensions,
          tiles: manifestTiles,
        } as const;
        const manifestStagingPath = path.join(staging, "manifest.json");
        yield* fs.writeFileString(manifestStagingPath, JSON.stringify(manifest, null, 2), {
          flag: "wx",
          mode: 0o600,
        });
        yield* fs.chmod(manifestStagingPath, 0o600);
        if (yield* fs.exists(destination)) {
          return yield* fail(`Screenshot tile-set destination already exists: ${destination}`);
        }
        const tiles = manifestTiles.map(({ file, y }) => ({
          path: path.join(destination, file),
          y,
        }));
        const manifestPath = path.join(destination, "manifest.json");
        const saved = {
          text: `Saved ${tiles.length} full-page screenshot tiles to ${destination}. Manifest: ${manifestPath}`,
          value: {
            kind: "tile-set",
            directory: destination,
            format: operation.format,
            manifestPath,
            tiles,
            dimensions: result.dimensions,
          },
        } satisfies SavedScreenshot;
        yield* fs.rename(staging, destination);
        return saved;
      }),
      removeStaging(fs, staging, true),
    );
  });

export const saveScreenshot = (cwd: string, operation: ScreenshotOperation, raw: unknown) =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(screenshotResultSchemaFor(operation), {
      onExcessProperty: "error",
    })(raw).pipe(
      Effect.mapError((cause) => fail(`Screenshot response is invalid: ${String(cause)}`, cause)),
    );

    const now = yield* Clock.currentTimeMillis;
    const generatedStem = `.pi/chrome-screenshots/${now}-${globalThis.crypto.randomUUID()}`;
    if (result.kind === "image") {
      const bytes = yield* decodeDataUrl(result.dataUrl, operation.format);
      return yield* publishImage(cwd, operation, bytes, generatedStem);
    }

    const tiles = yield* Effect.forEach(result.tiles, (tile) =>
      decodeDataUrl(tile.dataUrl, operation.format).pipe(
        Effect.map((bytes) => ({ y: tile.y, bytes })),
      ),
    );
    return yield* publishTileSet(
      cwd,
      operation,
      { dimensions: result.dimensions, tiles },
      generatedStem,
    );
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.failCause(
          Cause.map(cause, (error) =>
            error instanceof ScreenshotFailure
              ? error
              : fail("Could not publish the screenshot artifact", error),
          ),
        ),
      onSuccess: Effect.succeed,
    }),
  );
