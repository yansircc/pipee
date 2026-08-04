import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Semaphore } from "effect";
import {
  blobHash,
  commitHash,
  type ObjectHash,
  type SiteCommit,
} from "../src/domain/site-objects.js";
import { checkoutTool, pushTool, rebaseCheckout } from "../src/pi/checkout-tools.js";
import { run, type ActiveSession } from "../src/pi/session.js";

const temporary: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const siteCommit = (tree: ObjectHash, parents: readonly ObjectHash[], message: string) => {
  const commit: SiteCommit = {
    contract: "zeroy/site-commit@1",
    tree,
    parents,
    baseReleaseId: null,
    author: { principal: "site:test", actorSessionId: "rebase-test" },
    message,
    createdAt: "2026-08-03T00:00:00.000Z",
  };
  const hashed = commitHash(commit);
  if (hashed._tag === "Failure") throw new Error(hashed.error.message);
  return { commit, hash: hashed.value };
};

const fixture = async (
  baseDocument: unknown,
  oursDocument: unknown,
  remoteDocument: unknown,
  relative = "site.json",
) => {
  const baseDirectory = mkdtempSync(join(tmpdir(), "zeroy-git-rebase-"));
  temporary.push(baseDirectory);
  const root = join(baseDirectory, ".zeroy-checkouts", "test-checkout");
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".zeroy"), { recursive: true });
  git(root, "init");
  writeFileSync(join(root, ".git", "info", "exclude"), ".zeroy/\n");
  const encode = (value: unknown) =>
    relative.endsWith(".json") ? `${JSON.stringify(value, null, 2)}\n` : String(value);
  const baseBytes = Buffer.from(encode(baseDocument));
  const remoteBytes = remoteDocument === undefined ? null : Buffer.from(encode(remoteDocument));
  const target = join(root, relative);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, baseBytes);
  git(root, "add", "--all");
  git(root, "-c", "user.name=zeroY", "-c", "user.email=zeroy@local", "commit", "-m", "base");
  const baseGit = git(root, "rev-parse", "HEAD");
  const base = siteCommit(blobHash(Buffer.from("base-tree")), [], "base");
  git(root, "update-ref", `refs/zeroy/commits/${base.hash.slice(7)}`, baseGit);
  if (oursDocument === undefined) rmSync(target);
  else writeFileSync(target, encode(oursDocument));
  git(root, "add", "--all");
  git(root, "-c", "user.name=zeroY", "-c", "user.email=zeroy@local", "commit", "-m", "ours");
  const remote = siteCommit(blobHash(Buffer.from("remote-tree")), [base.hash], "remote");
  const objects = new Map<ObjectHash, Buffer>([[blobHash(baseBytes), baseBytes]]);
  if (remoteBytes !== null) objects.set(blobHash(remoteBytes), remoteBytes);
  const manifests = new Map<ObjectHash, unknown>([
    [
      base.hash,
      {
        commit: base.hash,
        baseReleaseId: null,
        files: [{ path: relative, hash: blobHash(baseBytes), mode: "file" }],
      },
    ],
    [
      remote.hash,
      {
        commit: remote.hash,
        baseReleaseId: null,
        files:
          remoteBytes === null
            ? []
            : [{ path: relative, hash: blobHash(remoteBytes), mode: "file" }],
      },
    ],
  ]);
  const commits = new Map<ObjectHash, SiteCommit>([[remote.hash, remote.commit]]);
  const state = {
    advanceDraftRef: false,
    authoredSeeds: {} as Record<string, { encoding: "utf8"; content: string }>,
    failPush: false,
    pushAttempts: 0,
    acceptedCommit: null as ObjectHash | null,
    reviewEndpoints: [] as string[],
  };
  const buildId = blobHash(Buffer.from("workspace-build"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const reply = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "POST") {
      let encoded = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        encoded += chunk;
      });
      request.on("end", () => {
        const body = encoded === "" ? {} : (JSON.parse(encoded) as Record<string, unknown>);
        if (url.pathname.endsWith("/site-objects/have")) return reply(200, { missing: [] });
        if (url.pathname.endsWith("/site-objects")) return reply(200, { accepted: true });
        if (url.pathname.endsWith("/site-commits")) {
          const hash = body.commitHash as ObjectHash;
          commits.set(hash, body.commit as SiteCommit);
          return reply(200, { accepted: true });
        }
        if (url.pathname.endsWith("/site-push")) {
          state.pushAttempts += 1;
          if (state.failPush)
            return reply(503, {
              error: { code: "zeroy_test_interrupted", message: "Interrupted after envelope." },
            });
          if (state.advanceDraftRef && state.pushAttempts === 1)
            return reply(409, {
              error: {
                code: "zeroy_remote_ref_changed",
                message: "DraftRef advanced.",
                data: {
                  currentCommit: remote.hash,
                  changedPathCount: 1,
                  changedPaths: [relative],
                },
              },
            });
          state.acceptedCommit = body.commitHash as ObjectHash;
          return reply(200, {
            contract: "zeroy/site-push-receipt@1",
            build: { buildId },
          });
        }
        return reply(404, { error: { code: "missing", message: "missing" } });
      });
      return;
    }
    let payload: unknown = null;
    if (url.pathname.endsWith(`/site-builds/${buildId}/workspace`))
      payload = { files: {}, authoredSeeds: state.authoredSeeds };
    else if (
      url.pathname.endsWith("/site-review/workspace") ||
      url.pathname.endsWith("/site-review/baseline-workspace")
    ) {
      state.reviewEndpoints.push(url.pathname);
      payload = {
        contract: url.pathname.endsWith("/site-review/baseline-workspace")
          ? "zeroy/site-review-baseline-workspace@1"
          : "zeroy/site-review-workspace@1",
        commitId: url.searchParams.get("commit"),
        buildId: url.searchParams.get("buildId"),
        files: {
          ".zeroy/brief.json": { contract: "zeroy/site-brief-projection@1", state: "present" },
          ".zeroy/review.json": url.pathname.endsWith("/site-review/baseline-workspace")
            ? { contract: "zeroy/review-onboarding@1", state: "onboarding", next: [] }
            : { contract: "zeroy/review-result@1", state: "revise", next: [] },
          ".zeroy/review.md": "# zeroY review\n",
        },
      };
    } else if (url.pathname.endsWith("/site-commit-diff"))
      payload = {
        contract: "zeroy/site-commit-diff@1",
        items: [{ path: relative }],
        hasMore: false,
        nextCursor: null,
      };
    else if (url.pathname.endsWith("/site-checkout")) {
      const selected = url.searchParams.get("commit") as ObjectHash | null;
      const manifest = manifests.get(selected ?? base.hash);
      payload =
        manifest === undefined
          ? undefined
          : { ...manifest, tree: base.commit.tree, build: { buildId } };
    } else if (url.pathname.includes("/site-commits/"))
      payload = {
        commit: commits.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? "") as ObjectHash),
      };
    else if (url.pathname.includes("/site-objects/")) {
      const bytes = objects.get(
        decodeURIComponent(url.pathname.split("/").at(-1) ?? "") as ObjectHash,
      );
      payload =
        bytes === undefined ? null : { objectType: "blob", bytesBase64: bytes.toString("base64") };
    }
    reply(
      payload === undefined || payload === null ? 404 : 200,
      payload ?? { error: { code: "missing", message: "missing" } },
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing test server address");
  const mutationGate = await run(Semaphore.make(1));
  const active = {
    context: { cwd: baseDirectory },
    draftActorId: "rebase-test",
    connections: [
      {
        siteId: "test",
        label: "test",
        endpoint: `http://127.0.0.1:${address.port}`,
        connectionKey: "test",
      },
    ],
    mutationGates: new Map([["test", mutationGate]]),
  } as unknown as ActiveSession;
  const descriptor = {
    contract: "zeroy/checkout@1" as const,
    siteId: "test",
    checkoutId: "checkout",
    remoteRef: "refs/drafts/test/checkout",
    observedCommit: base.hash,
    expectedRefCommit: base.hash,
    baseReleaseId: null,
    materializedAt: "2026-08-03T00:00:00.000Z",
  };
  writeFileSync(join(root, ".zeroy", "checkout.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  return { root, active, descriptor, base, remote, baseGit, relative, state };
};

describe("zeroY literal Git rebase", () => {
  it("projects authored seeds after recording the exact SiteCommit baseline", async () => {
    const setup = await fixture({ title: "base" }, { title: "ours" }, { title: "base" });
    setup.state.authoredSeeds = {
      "content/posts/pages/adopt-me.json": {
        encoding: "utf8",
        content: '{"route":"/adopt-me/"}\n',
      },
    };
    const checkedOut = await run(
      checkoutTool(
        setup.active,
        { siteId: "test", source: "draft-ref", draftRef: "refs/drafts/test/checkout" },
        undefined,
      ),
    );
    const payload = JSON.parse(
      (checkedOut.content[0] as { readonly type: "text"; readonly text: string }).text,
    );

    expect(git(payload.path, "ls-files", "content/posts/pages/adopt-me.json")).toBe("");
    expect(git(payload.path, "status", "--short", "--untracked-files=all")).toContain(
      "?? content/posts/pages/adopt-me.json",
    );
    expect(setup.state.reviewEndpoints).toEqual(["/wp-json/zeroy/v1/site-review/workspace"]);
  }, 20_000);

  it("uses an onboarding projection only when checkout starts from the shared active release", async () => {
    const setup = await fixture({ title: "base" }, { title: "ours" }, { title: "base" });
    const checkedOut = await run(
      checkoutTool(setup.active, { siteId: "test", source: "active-release" }, undefined),
    );

    const payload = JSON.parse(
      (checkedOut.content[0] as { readonly type: "text"; readonly text: string }).text,
    );
    expect(readFileSync(join(payload.path, ".zeroy", "review.json"), "utf8")).toContain(
      "zeroy/review-onboarding@1",
    );
    expect(setup.state.reviewEndpoints).toEqual([
      "/wp-json/zeroy/v1/site-review/baseline-workspace",
    ]);
  }, 20_000);

  it("rebases a semantic JSON merge onto the materialized remote commit", async () => {
    const setup = await fixture(
      { title: "base", body: "base" },
      { title: "ours", body: "base" },
      { title: "base", body: "remote" },
    );
    const conflicts = await run(
      rebaseCheckout(
        setup.active,
        "test",
        setup.root,
        setup.descriptor,
        setup.remote.hash,
        ["site.json"],
        ["site.json"],
        undefined,
      ),
    );
    expect(conflicts).toEqual([]);
    expect(JSON.parse(readFileSync(join(setup.root, "site.json"), "utf8"))).toEqual({
      body: "remote",
      title: "ours",
    });
    expect(git(setup.root, "rev-parse", "HEAD")).toBe(
      git(setup.root, "rev-parse", `refs/zeroy/commits/${setup.remote.hash.slice(7)}`),
    );
    expect(git(setup.root, "status", "--short")).toBe("M site.json");
  }, 20_000);

  it("rebases non-overlapping text edits", async () => {
    const setup = await fixture(
      "first\nsecond\nthird\n",
      "ours\nsecond\nthird\n",
      "first\nsecond\nremote\n",
      "artifacts/theme/index.php",
    );
    const relative = "artifacts/theme/index.php";
    const conflicts = await run(
      rebaseCheckout(
        setup.active,
        "test",
        setup.root,
        setup.descriptor,
        setup.remote.hash,
        [relative],
        [relative],
        undefined,
      ),
    );
    expect(conflicts).toEqual([]);
    expect(readFileSync(join(setup.root, relative), "utf8")).toBe("ours\nsecond\nremote\n");
  }, 20_000);

  it("preserves the Git conflict index for a same-leaf JSON conflict", async () => {
    const setup = await fixture(
      { title: "base", body: "base" },
      { title: "ours", body: "base" },
      { title: "remote", body: "base" },
    );
    const conflicts = await run(
      rebaseCheckout(
        setup.active,
        "test",
        setup.root,
        setup.descriptor,
        setup.remote.hash,
        ["site.json"],
        ["site.json"],
        undefined,
      ),
    );
    expect(conflicts).toContainEqual({ path: "site.json", fieldPath: "/title", kind: "content" });
    expect(git(setup.root, "diff", "--name-only", "--diff-filter=U")).toBe("site.json");
  }, 20_000);

  it("preserves delete-modify conflicts in the Git index", async () => {
    const setup = await fixture({ title: "base" }, undefined, { title: "remote" });
    const conflicts = await run(
      rebaseCheckout(
        setup.active,
        "test",
        setup.root,
        setup.descriptor,
        setup.remote.hash,
        ["site.json"],
        ["site.json"],
        undefined,
      ),
    );
    expect(conflicts).toContainEqual({ path: "site.json", kind: "delete-modify" });
    expect(git(setup.root, "diff", "--name-only", "--diff-filter=U")).toBe("site.json");
  }, 20_000);

  it("retries the whole push after a non-overlapping remote DraftRef advance", async () => {
    const setup = await fixture(
      { title: "base", body: "base" },
      { title: "ours", body: "base" },
      { title: "base", body: "remote" },
    );
    git(setup.root, "reset", "--hard", setup.baseGit);
    writeFileSync(
      join(setup.root, setup.relative),
      `${JSON.stringify({ title: "ours", body: "base" }, null, 2)}\n`,
    );
    setup.state.advanceDraftRef = true;

    const pushed = await run(
      pushTool(
        setup.active,
        { siteId: "test", checkoutId: "checkout", message: "merge" },
        undefined,
      ),
    );

    expect(setup.state.pushAttempts).toBe(2);
    expect(setup.state.acceptedCommit).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(join(setup.root, setup.relative), "utf8"))).toEqual({
      body: "remote",
      title: "ours",
    });
    expect(existsSync(join(setup.root, ".zeroy", "pending-push.json"))).toBe(false);
    expect(existsSync(join(setup.root, ".zeroy", "conflicts.json"))).toBe(false);
    expect(pushed.content[0]).toMatchObject({ type: "text" });
  }, 60_000);

  it("writes a durable conflict fact when the same JSON leaf changed remotely", async () => {
    const setup = await fixture(
      { title: "base", body: "base" },
      { title: "ours", body: "base" },
      { title: "remote", body: "base" },
    );
    git(setup.root, "reset", "--hard", setup.baseGit);
    writeFileSync(
      join(setup.root, setup.relative),
      `${JSON.stringify({ title: "ours", body: "base" }, null, 2)}\n`,
    );
    setup.state.advanceDraftRef = true;

    await expect(
      run(
        pushTool(
          setup.active,
          { siteId: "test", checkoutId: "checkout", message: "conflict" },
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: "zeroy_checkout_conflict" });

    const fact = JSON.parse(readFileSync(join(setup.root, ".zeroy", "conflicts.json"), "utf8"));
    expect(fact.conflicts).toContainEqual({
      path: "site.json",
      fieldPath: "/title",
      kind: "content",
    });
    expect(existsSync(join(setup.root, ".zeroy", "pending-push.json"))).toBe(false);
  }, 30_000);

  it("blocks different checkout bytes while a prior push envelope is unresolved", async () => {
    const setup = await fixture({ title: "base" }, { title: "first" }, { title: "base" });
    git(setup.root, "reset", "--hard", setup.baseGit);
    writeFileSync(
      join(setup.root, setup.relative),
      `${JSON.stringify({ title: "first" }, null, 2)}\n`,
    );
    setup.state.advanceDraftRef = false;
    setup.state.failPush = true;
    await expect(
      run(
        pushTool(
          setup.active,
          { siteId: "test", checkoutId: "checkout", message: "first" },
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: "zeroy_test_interrupted" });
    expect(existsSync(join(setup.root, ".zeroy", "pending-push.json"))).toBe(true);

    writeFileSync(
      join(setup.root, setup.relative),
      `${JSON.stringify({ title: "second" }, null, 2)}\n`,
    );

    await expect(
      run(
        pushTool(
          setup.active,
          { siteId: "test", checkoutId: "checkout", message: "second" },
          undefined,
        ),
      ),
    ).rejects.toMatchObject({ code: "zeroy_pending_push_conflict" });
  }, 30_000);
});
