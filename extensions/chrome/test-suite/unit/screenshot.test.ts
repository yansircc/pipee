import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { saveScreenshot } from "../../src/pi/screenshot.js";
import type { PageCall } from "../../src/protocol/schema.js";
import { assertPosixFileMode } from "../support/posix-file-mode.js";

type ScreenshotOperation = Extract<PageCall["operation"], { readonly kind: "screenshot" }>;

const withTemporaryDirectory = <A, E>(
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-screenshot-" });
      return yield* use(directory);
    }),
  ).pipe(Effect.provide(nodeServicesLayer));

const tab = {
  id: 7,
  windowId: 3,
  active: true,
  highlighted: true,
  title: "Screenshot fixture",
  url: "https://example.test/screenshot",
  groupId: -1,
  group: null,
} as const;

const dimensions = {
  width: 10,
  height: 20,
  viewportHeight: 10,
  dpr: 1,
} as const;

const viewport = (path?: string, format: "png" | "jpeg" = "png"): ScreenshotOperation =>
  ({
    kind: "screenshot",
    format,
    capture: path === undefined ? { kind: "viewport" } : { kind: "viewport", path },
  }) as ScreenshotOperation;

const tileSet = (directory?: string, format: "png" | "jpeg" = "png"): ScreenshotOperation =>
  ({
    kind: "screenshot",
    format,
    capture:
      directory === undefined
        ? { kind: "full-page-tiles" }
        : { kind: "full-page-tiles", directory },
  }) as ScreenshotOperation;

const dataUrl = (bytes: string, format: "png" | "jpeg" = "png") =>
  `data:image/${format};base64,${Buffer.from(bytes).toString("base64")}`;

const imageResult = (bytes: string, format: "png" | "jpeg" = "png") => ({
  kind: "image" as const,
  format,
  dataUrl: dataUrl(bytes, format),
  tab,
});

const tileSetResult = (
  tiles: ReadonlyArray<{ readonly y: number; readonly bytes: string }>,
  format: "png" | "jpeg" = "png",
) => ({
  kind: "tile-set" as const,
  format,
  tab,
  dimensions,
  tiles: tiles.map(({ y, bytes }) => ({ y, dataUrl: dataUrl(bytes, format) })),
});

const withFileSystemOverride = <A, E, R>(
  effect: Effect.Effect<A, E, R | FileSystem.FileSystem>,
  override: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const injected = Object.assign(Object.create(fs), override(fs)) as FileSystem.FileSystem;
    return yield* effect.pipe(Effect.provideService(FileSystem.FileSystem, injected));
  });

const expectNoStaging = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(directory, { recursive: true });
    expect(entries.some((entry) => entry.includes(".staging-"))).toBe(false);
  });

const injectedFileSystemFailure = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: "injected screenshot publication failure",
  });

it.effect("replaces screenshot image data with a durable artifact summary", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.realPath(directory);
      const saved = yield* saveScreenshot(
        directory,
        viewport("capture.png"),
        imageResult("image-bytes"),
      );

      const outputPath = path.join(workspace, "capture.png");
      expect(saved.value).toEqual({ kind: "image", path: outputPath, format: "png" });
      expect(JSON.stringify(saved)).not.toContain("data:image/");
      expect(Buffer.from(yield* fs.readFile(outputPath)).toString()).toBe("image-bytes");
    }),
  ),
);

it.effect("publishes one complete tile-set directory without claiming a stitched image", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fs.realPath(directory);
      const saved = yield* saveScreenshot(
        directory,
        tileSet("page-tiles"),
        tileSetResult([
          { y: 0, bytes: "tile-zero" },
          { y: 10, bytes: "tile-one" },
        ]),
      );

      expect(saved.value).toMatchObject({
        kind: "tile-set",
        directory: path.join(workspace, "page-tiles"),
        format: "png",
        dimensions: { width: 10, height: 20 },
        tiles: [{ y: 0 }, { y: 10 }],
      });
      expect(saved.text).not.toContain("stitched");
      expect(JSON.stringify(saved)).not.toContain("data:image/");
      if (saved.value.kind === "tile-set") {
        expect(yield* fs.exists(saved.value.manifestPath)).toBe(true);
        expect(yield* Effect.forEach(saved.value.tiles, ({ path }) => fs.exists(path))).toEqual([
          true,
          true,
        ]);
        expect(JSON.parse(yield* fs.readFileString(saved.value.manifestPath))).toMatchObject({
          version: 1,
          kind: "tile-set",
          format: "png",
          tiles: [{ file: "tile-0000.png" }, { file: "tile-0001.png" }],
        });
      }
    }),
  ),
);

it.effect("rejects MIME, extension, and path escapes before publishing an image", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wrongMime = {
        kind: "image",
        format: "png",
        dataUrl: dataUrl("jpeg-bytes", "jpeg"),
        tab,
      } as const;

      for (const operation of [
        viewport("capture.jpeg"),
        viewport("../capture.png"),
        viewport(path.join(directory, "absolute.png")),
      ]) {
        expect(
          (yield* Effect.exit(saveScreenshot(directory, operation, imageResult("image"))))._tag,
        ).toBe("Failure");
      }
      expect(
        (yield* Effect.exit(saveScreenshot(directory, viewport("mime.png"), wrongMime)))._tag,
      ).toBe("Failure");

      expect(yield* fs.exists(path.join(directory, "capture.jpeg"))).toBe(false);
      expect(yield* fs.exists(path.join(directory, "mime.png"))).toBe(false);
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("rejects a symbolic-link escape from the workspace", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "pi-chrome-outside-" });
      yield* fs.symlink(outside, path.join(directory, "escape"));

      const result = yield* Effect.exit(
        saveScreenshot(directory, viewport("escape/capture.png"), imageResult("secret")),
      );

      expect(result._tag).toBe("Failure");
      expect(yield* fs.exists(path.join(outside, "capture.png"))).toBe(false);
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("decodes every tile and validates complete geometry before any filesystem write", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const invalidBase64 = {
        ...tileSetResult([
          { y: 0, bytes: "first" },
          { y: 10, bytes: "second" },
        ]),
        tiles: [
          { y: 0, dataUrl: dataUrl("first") },
          { y: 10, dataUrl: "data:image/png;base64,a" },
        ],
      };
      const incomplete = tileSetResult([{ y: 0, bytes: "only" }]);
      const duplicateY = tileSetResult([
        { y: 0, bytes: "first" },
        { y: 0, bytes: "second" },
      ]);

      for (const [name, result] of [
        ["bad-base64", invalidBase64],
        ["missing-tile", incomplete],
        ["duplicate-y", duplicateY],
      ] as const) {
        expect((yield* Effect.exit(saveScreenshot(directory, tileSet(name), result)))._tag).toBe(
          "Failure",
        );
        expect(yield* fs.exists(path.join(directory, name))).toBe(false);
      }

      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("preserves an existing image when staging write or atomic rename fails", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      for (const failedMethod of ["writeFile", "rename"] as const) {
        const destination = path.join(directory, `${failedMethod}.png`);
        yield* fs.writeFileString(destination, `existing-${failedMethod}`);
        const attempted = yield* Effect.exit(
          withFileSystemOverride(
            saveScreenshot(directory, viewport(`${failedMethod}.png`), imageResult("replacement")),
            (base) =>
              failedMethod === "writeFile"
                ? {
                    writeFile: (file, bytes, options) =>
                      file.includes(".staging-")
                        ? Effect.fail(injectedFileSystemFailure("writeFile", file))
                        : base.writeFile(file, bytes, options),
                  }
                : {
                    rename: (from, to) =>
                      from.includes(".staging-")
                        ? Effect.fail(injectedFileSystemFailure("rename", from))
                        : base.rename(from, to),
                  },
          ),
        );

        expect(attempted._tag).toBe("Failure");
        expect(yield* fs.readFileString(destination)).toBe(`existing-${failedMethod}`);
      }
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("does not run staging rollback after an image or tile-set commit", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = [
        {
          operation: viewport("committed.png"),
          result: imageResult("committed-image"),
          destination: path.join(directory, "committed.png"),
        },
        {
          operation: tileSet("committed-tiles"),
          result: tileSetResult([
            { y: 0, bytes: "tile-zero" },
            { y: 10, bytes: "tile-one" },
          ]),
          destination: path.join(directory, "committed-tiles"),
        },
      ] as const;

      for (const fixture of fixtures) {
        let stagingRemoveCalls = 0;
        const saved = yield* withFileSystemOverride(
          saveScreenshot(directory, fixture.operation, fixture.result),
          (base) => ({
            remove: (file, options) => {
              if (file.includes(".staging-")) {
                return Effect.suspend(() => {
                  stagingRemoveCalls += 1;
                  return Effect.fail(injectedFileSystemFailure("remove", file));
                });
              }
              return base.remove(file, options);
            },
          }),
        );

        expect(saved.value.kind).toBe(fixture.result.kind);
        expect(stagingRemoveCalls).toBe(0);
        expect(yield* fs.exists(fixture.destination)).toBe(true);
      }
    }),
  ),
);

it.effect("reports the staging path when rollback cleanup itself fails", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const attempted = yield* Effect.exit(
        withFileSystemOverride(
          saveScreenshot(directory, viewport("cleanup.png"), imageResult("sensitive")),
          (base) => ({
            rename: (from, to) =>
              from.includes(".staging-")
                ? Effect.fail(injectedFileSystemFailure("rename", from))
                : base.rename(from, to),
            remove: (file, options) =>
              file.includes(".staging-")
                ? Effect.fail(injectedFileSystemFailure("remove", file))
                : base.remove(file, options),
          }),
        ),
      );

      expect(attempted._tag).toBe("Failure");
      if (attempted._tag === "Failure") {
        const report = Cause.pretty(attempted.cause);
        expect(report).toContain("Could not publish the screenshot artifact");
        expect(report).toContain("Could not remove screenshot staging artifact");
      }
      const fs = yield* FileSystem.FileSystem;
      expect(
        (yield* fs.readDirectory(directory)).some((entry) => entry.includes(".staging-")),
      ).toBe(true);
    }),
  ),
);

it.effect("removes an incomplete tile-set when a later tile write fails", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let tileWrites = 0;
      const attempted = yield* Effect.exit(
        withFileSystemOverride(
          saveScreenshot(
            directory,
            tileSet("failed-tiles"),
            tileSetResult([
              { y: 0, bytes: "first" },
              { y: 10, bytes: "second" },
            ]),
          ),
          (base) => ({
            writeFile: (file, bytes, options) => {
              if (file.includes(".staging-") && path.basename(file).startsWith("tile-")) {
                tileWrites += 1;
                if (tileWrites === 2) {
                  return Effect.fail(injectedFileSystemFailure("writeFile", file));
                }
              }
              return base.writeFile(file, bytes, options);
            },
          }),
        ),
      );

      expect(attempted._tag).toBe("Failure");
      expect(yield* fs.exists(path.join(directory, "failed-tiles"))).toBe(false);
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("removes an incomplete tile-set when manifest publication fails", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attempted = yield* Effect.exit(
        withFileSystemOverride(
          saveScreenshot(
            directory,
            tileSet("failed-manifest"),
            tileSetResult([
              { y: 0, bytes: "first" },
              { y: 10, bytes: "second" },
            ]),
          ),
          (base) => ({
            writeFileString: (file, value, options) =>
              path.basename(file) === "manifest.json"
                ? Effect.fail(injectedFileSystemFailure("writeFileString", file))
                : base.writeFileString(file, value, options),
          }),
        ),
      );

      expect(attempted._tag).toBe("Failure");
      expect(yield* fs.exists(path.join(directory, "failed-manifest"))).toBe(false);
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("fails closed when a tile-set destination already exists", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(directory, "existing-tiles");
      const marker = path.join(destination, "marker.txt");
      yield* fs.makeDirectory(destination);
      yield* fs.writeFileString(marker, "keep-me");

      const attempted = yield* Effect.exit(
        saveScreenshot(
          directory,
          tileSet("existing-tiles"),
          tileSetResult([
            { y: 0, bytes: "first" },
            { y: 10, bytes: "second" },
          ]),
        ),
      );

      expect(attempted._tag).toBe("Failure");
      expect(yield* fs.readFileString(marker)).toBe("keep-me");
      expect((yield* fs.readDirectory(destination)).sort()).toEqual(["marker.txt"]);
      yield* expectNoStaging(directory);
    }),
  ),
);

it.effect("publishes private image and tile-set permissions", () =>
  withTemporaryDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const image = yield* saveScreenshot(
        directory,
        viewport("private.png"),
        imageResult("private-image"),
      );
      const tiles = yield* saveScreenshot(
        directory,
        tileSet("private-tiles"),
        tileSetResult([
          { y: 0, bytes: "first" },
          { y: 10, bytes: "second" },
        ]),
      );

      assertPosixFileMode(
        (yield* fs.stat(image.value.kind === "image" ? image.value.path : "")).mode,
        0o600,
      );
      if (tiles.value.kind === "tile-set") {
        assertPosixFileMode((yield* fs.stat(tiles.value.directory)).mode, 0o700);
        assertPosixFileMode((yield* fs.stat(tiles.value.manifestPath)).mode, 0o600);
        for (const tile of tiles.value.tiles) {
          assertPosixFileMode((yield* fs.stat(tile.path)).mode, 0o600);
        }
      }
    }),
  ),
);
