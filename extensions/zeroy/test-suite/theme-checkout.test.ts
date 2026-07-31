import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createThemeCheckout,
  listThemeCheckouts,
  manifestIdentity,
  prepareThemeSeed,
  prepareThemePush,
  type ThemeManifest,
  type ThemePolicy,
} from "../src/domain/theme-checkout.js";

const policy: ThemePolicy = {
  contract: "zeroy/theme-artifact-policy@1",
  forbiddenPaths: [".git/**", "node_modules/**", ".DS_Store", "*.log"],
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxStorageBytes: 64 * 1024 * 1024,
  allowSymlinks: false,
};

const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const command = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "zeroy-theme-checkout-test-"));
  writeFileSync(
    join(root, "functions.php"),
    "<?php\nadd_action('wp_head', static fn() => null);\n",
  );
  writeFileSync(join(root, "zeroy.schema.json"), '{"contract":"zeroy/theme-schema@1"}\n');
  command(root, ["init"]);
  command(root, ["add", "-A"]);
  command(root, [
    "-c",
    "user.name=zeroY test",
    "-c",
    "user.email=test@zeroy.local",
    "commit",
    "-m",
    "fixture",
  ]);
  const entries = ["functions.php", "zeroy.schema.json"].map((path) => {
    const bytes = readFileSync(join(root, path));
    return { path, hash: hash(bytes), bytes: bytes.length, mode: "file" as const };
  });
  const manifest: ThemeManifest = { contract: "zeroy/theme-manifest@1", entries };
  const archive = join(root, "artifact.tar.gz");
  command(root, ["archive", "--format=tar.gz", `--output=${archive}`, "HEAD"]);
  return { root, manifest, archiveBase64: readFileSync(archive).toString("base64") };
};

const removeDirectory = (directory: string) =>
  Effect.sync(() => rmSync(directory, { recursive: true, force: true }));

const withFixture = <A, E, R>(
  use: (source: ReturnType<typeof fixture>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(Effect.sync(fixture), use, (source) => removeDirectory(source.root));

it.effect(
  "materializes the verified artifact, rejects dirty HEAD, and packages committed HEAD only",
  () =>
    withFixture((source) => {
      const siteId = `theme-checkout-test-${randomUUID()}`;
      const artifactId = manifestIdentity(source.manifest);
      return Effect.acquireUseRelease(
        createThemeCheckout({
          siteId,
          artifactId,
          deploymentId: "deployment-test",
          manifest: source.manifest,
          archiveBase64: source.archiveBase64,
          policy,
        }),
        (checkout) =>
          Effect.gen(function* () {
            expect(checkout.head).not.toBe("");
            expect(yield* listThemeCheckouts(siteId)).toMatchObject([
              { checkoutId: checkout.checkoutId, dirty: false, head: checkout.head },
            ]);

            yield* Effect.sync(() =>
              writeFileSync(join(checkout.localPath, "functions.php"), "<?php\n// dirty\n"),
            );
            const dirty = yield* prepareThemePush(checkout.checkoutId).pipe(Effect.flip);
            expect(dirty).toMatchObject({
              _tag: "ThemeCheckoutError",
              operation: "checkout.push.clean",
            });

            yield* Effect.sync(() => {
              command(checkout.localPath, ["add", "functions.php"]);
              command(checkout.localPath, [
                "-c",
                "user.name=zeroY test",
                "-c",
                "user.email=test@zeroy.local",
                "commit",
                "-m",
                "change",
              ]);
            });
            const push = yield* prepareThemePush(checkout.checkoutId);
            expect(push.sourceCommit).toBe(
              yield* Effect.sync(() => command(checkout.localPath, ["rev-parse", "HEAD"])),
            );
            expect(push.manifest.entries).toHaveLength(2);
            expect(push.manifest.entries[0]?.hash).not.toBe(source.manifest.entries[0]?.hash);
            expect(Buffer.from(push.archiveBase64, "base64").byteLength).toBeGreaterThan(0);

            const invalid = yield* createThemeCheckout({
              siteId: `${siteId}-invalid`,
              artifactId: `sha256:${"0".repeat(64)}`,
              deploymentId: "deployment-test",
              manifest: source.manifest,
              archiveBase64: source.archiveBase64,
              policy,
            }).pipe(Effect.flip);
            expect(invalid).toMatchObject({
              _tag: "ThemeCheckoutError",
              operation: "checkout.manifest.identity",
            });
          }),
        (checkout) => removeDirectory(join(checkout.localPath, "..")),
      );
    }).pipe(Effect.provide(nodeServicesLayer)),
);

it.effect("packages a bundled bootstrap seed through a temporary Git HEAD", () =>
  prepareThemeSeed({
    sourceDirectory: join(process.cwd(), "mvp-theme"),
    policy,
  }).pipe(
    Effect.tap((seed) =>
      Effect.sync(() => {
        expect(seed.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(seed.manifest.entries.some((entry) => entry.path === "zeroy.schema.json")).toBe(
          true,
        );
        expect(Buffer.from(seed.archiveBase64, "base64").byteLength).toBeGreaterThan(0);
      }),
    ),
    Effect.provide(nodeServicesLayer),
  ),
);
