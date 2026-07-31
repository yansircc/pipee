import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createSiteWorkspace,
  prepareSitePush,
  type ArtifactManifest,
  type ArtifactPolicy,
} from "../src/domain/site-workspace.js";

const policy: ArtifactPolicy = {
  contract: "zeroy/artifact-policy@test",
  forbiddenPaths: [".git/**"],
  maxFiles: 100,
  maxFileBytes: 1024 * 1024,
  maxArtifactBytes: 8 * 1024 * 1024,
  maxStorageBytes: 64 * 1024 * 1024,
  allowSymlinks: false,
};
const command = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const archive = (cwd: string, tree: string) =>
  Buffer.from(
    execFileSync("git", ["archive", "--format=tar.gz", `HEAD:${tree}`], { cwd }),
  ).toString("base64");
const manifest = (
  root: string,
  paths: string[],
  contract: ArtifactManifest["contract"],
): ArtifactManifest => ({
  contract,
  entries: paths.map((path) => {
    const bytes = readFileSync(join(root, path));
    return {
      path: path.replace(/^(theme|site-logic)\//, ""),
      hash: hash(bytes),
      bytes: bytes.length,
      mode: "file",
    };
  }),
});

it.effect("requires one clean committed HEAD to produce both SiteRelease artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "zeroy-site-workspace-test-"));
  try {
    execFileSync("mkdir", ["-p", join(root, "theme"), join(root, "site-logic")]);
    writeFileSync(join(root, "theme", "functions.php"), "<?php\n");
    writeFileSync(
      join(root, "theme", "zeroy.schema.json"),
      '{"contract":"zeroy/theme-schema@1"}\n',
    );
    writeFileSync(
      join(root, "theme", "zeroy.theme.json"),
      '{"contract":"zeroy/theme-manifest@2","requiresCapabilities":{}}\n',
    );
    writeFileSync(join(root, "site-logic", "bootstrap.php"), "<?php\n");
    writeFileSync(
      join(root, "site-logic", "sitelogic.json"),
      '{"contract":"zeroy/site-logic-contract@1","provides":[],"requires":[],"storageEpoch":0}\n',
    );
    command(root, ["init"]);
    command(root, ["add", "-A"]);
    command(root, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@zeroY",
      "commit",
      "-m",
      "fixture",
    ]);
    const theme = manifest(
      root,
      ["theme/functions.php", "theme/zeroy.schema.json", "theme/zeroy.theme.json"],
      "zeroy/theme-manifest@1",
    );
    const siteLogic = manifest(
      root,
      ["site-logic/bootstrap.php", "site-logic/sitelogic.json"],
      "zeroy/site-logic-manifest@1",
    );
    return Effect.acquireUseRelease(
      createSiteWorkspace({
        siteId: `site-${randomUUID()}`,
        releaseId: "release-a",
        themeArtifactId: "sha256:theme",
        siteLogicArtifactId: "sha256:logic",
        theme: { manifest: theme, archiveBase64: archive(root, "theme"), policy },
        siteLogic: { manifest: siteLogic, archiveBase64: archive(root, "site-logic"), policy },
      }),
      (workspace) =>
        Effect.gen(function* () {
          expect((yield* prepareSitePush(workspace.checkoutId)).sourceCommit).toBe(workspace.head);
          writeFileSync(join(workspace.localPath, "theme", "functions.php"), "<?php // dirty\n");
          expect(yield* prepareSitePush(workspace.checkoutId).pipe(Effect.flip)).toMatchObject({
            _tag: "SiteWorkspaceError",
            operation: "workspace.push.clean",
          });
        }),
      (workspace) =>
        Effect.sync(() => rmSync(workspace.localPath, { recursive: true, force: true })),
    ).pipe(Effect.provide(nodeServicesLayer));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
