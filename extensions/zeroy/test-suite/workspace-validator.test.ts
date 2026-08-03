import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { validateWorkspaceDocuments } from "../src/domain/workspace-validator.js";
import { run } from "../src/pi/session.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "zeroy-workspace-contract-"));
  roots.push(root);
  await mkdir(join(root, ".zeroy", "contracts"), { recursive: true });
  await writeFile(
    join(root, ".zeroy", "contracts", "site.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["workspaceFormat"],
      properties: { workspaceFormat: { const: "zeroy/site-tree@2" } },
    }),
  );
  return root;
};

describe("projected WorkspaceContract validation", () => {
  it("evaluates Connector-owned closed schemas without duplicating document semantics", async () => {
    const root = await workspace();
    await writeFile(
      join(root, "site.json"),
      JSON.stringify({ workspaceFormat: "zeroy/site-tree@2" }),
    );
    expect(await run(validateWorkspaceDocuments(root, ["site.json"]))).toEqual({
      failures: [],
      stalePaths: [],
    });
    await writeFile(
      join(root, "site.json"),
      JSON.stringify({ workspaceFormat: "zeroy/site-tree@2", duplicateOwner: true }),
    );
    const invalid = await run(validateWorkspaceDocuments(root, ["site.json"]));
    expect(invalid.failures).toHaveLength(1);
    expect(invalid.failures[0]?.contract).toBe(".zeroy/contracts/site.schema.json");
  });

  it("reports a missing concrete contract as stale instead of inventing a grammar", async () => {
    const root = await workspace();
    await mkdir(join(root, "content", "posts", "machines"), { recursive: true });
    await writeFile(join(root, "content", "posts", "machines", "mill.json"), "{}");
    expect(
      await run(validateWorkspaceDocuments(root, ["content/posts/machines/mill.json"])),
    ).toEqual({ failures: [], stalePaths: ["content/posts/machines/mill.json"] });
  });

  it("does not override the projected SiteCopy contract", async () => {
    const root = await workspace();
    await mkdir(join(root, "content"), { recursive: true });
    await mkdir(join(root, ".zeroy", "contracts", "content"), { recursive: true });
    await writeFile(
      join(root, ".zeroy", "contracts", "content", "site-copy.schema.json"),
      JSON.stringify({
        type: "object",
        additionalProperties: false,
        properties: { nav_home: { type: "string" } },
      }),
    );
    await writeFile(
      join(root, "content", "site-copy.json"),
      JSON.stringify({ nav_home: "Home", nav_contact: "Contact" }),
    );
    const result = await run(validateWorkspaceDocuments(root, ["content/site-copy.json"]));
    expect(result.stalePaths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe("content/site-copy.json");
  });
});
