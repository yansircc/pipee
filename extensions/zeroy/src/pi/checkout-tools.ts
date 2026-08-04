import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { DateTime, FileSystem, Path } from "effect";
import type { NodeServices } from "@effect/platform-node/NodeServices";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Effect } from "effect";
import { connectorGet, connectorPost, ZeroYConnectorError } from "../domain/client.js";
import type { CheckoutInput, JsonRecord, PushInput } from "../domain/protocol.js";
import {
  blobHash,
  canonicalJsonDocument,
  checkoutPathIsSafe,
  commitHash,
  decodeSiteCommit,
  normalizeCheckoutText,
  pushRequestHash,
  treeBytes,
  treeHash,
  type ObjectHash,
  type SiteCommit,
  type SiteObjectResult,
  type SiteTreeEntry,
} from "../domain/site-objects.js";
import {
  decodeJsonDocument,
  encodeJsonDocument,
  incompleteMergeConflictKind,
  isMergeableTextPath,
  mergeJsonDocuments,
  normalizedTextBytes,
  type MergeConflict,
} from "../domain/site-merge.js";
import { verifyBrowserChallenge } from "../domain/browser-verifier.js";
import { validateWorkspaceDocuments } from "../domain/workspace-validator.js";
import {
  connection,
  type ActiveSession,
  withLivePresentation,
  withSiteMutationGate,
} from "./session.js";
import { result, text, type ZeroYToolFailure } from "./tool-result.js";

type CheckoutDescriptor = {
  readonly contract: "zeroy/checkout@1";
  readonly siteId: string;
  readonly checkoutId: string;
  readonly remoteRef: string;
  readonly observedCommit: ObjectHash | null;
  readonly expectedRefCommit: ObjectHash | null;
  readonly baseReleaseId: string | null;
  readonly materializedAt: string;
};

type StoredObject = {
  readonly objectHash: ObjectHash;
  readonly objectType: "blob" | "tree";
  readonly bytes: Uint8Array;
};

type PendingPush = {
  readonly contract: "zeroy/pending-push@3";
  readonly commandId: string;
  readonly requestHash: string;
  readonly commitHash: ObjectHash;
  readonly commit: SiteCommit;
  readonly expectedCommit: ObjectHash | null;
  readonly rootTree: ObjectHash;
  readonly message: string;
  readonly changeSummary: {
    readonly changedPathCount: number;
    readonly changedSubjectCount: number;
    readonly uploadedObjectCount: number;
    readonly uploadedBytes: number;
  };
};

const failure = (message: string, code = "zeroy_checkout_io_failed") =>
  new ZeroYConnectorError({ message, code });

const fromSiteObjectResult = <A>(
  value: SiteObjectResult<A>,
): Effect.Effect<A, ZeroYConnectorError> =>
  value._tag === "Success"
    ? Effect.succeed(value.value)
    : Effect.fail(failure(value.error.message, `zeroy_${value.error.code}`));

const io = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => failure(`${label}: ${String(cause)}`)));

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const hasExactKeys = (value: JsonRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const decodePendingPush = (value: unknown): PendingPush | null => {
  const pending = asRecord(value);
  if (
    pending === null ||
    !hasExactKeys(pending, [
      "contract",
      "commandId",
      "requestHash",
      "commitHash",
      "commit",
      "expectedCommit",
      "rootTree",
      "message",
      "changeSummary",
    ]) ||
    pending.contract !== "zeroy/pending-push@3" ||
    typeof pending.commandId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(pending.commandId) ||
    typeof pending.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(pending.requestHash) ||
    typeof pending.commitHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(pending.commitHash) ||
    (pending.expectedCommit !== null &&
      (typeof pending.expectedCommit !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(pending.expectedCommit))) ||
    typeof pending.rootTree !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(pending.rootTree) ||
    typeof pending.message !== "string"
  ) {
    return null;
  }
  const summary = asRecord(pending.changeSummary);
  const decodedCommit = decodeSiteCommit(pending.commit);
  if (decodedCommit._tag === "Failure") return null;
  const actualCommitHash = commitHash(decodedCommit.value);
  if (
    actualCommitHash._tag === "Failure" ||
    actualCommitHash.value !== pending.commitHash ||
    decodedCommit.value.tree !== pending.rootTree ||
    summary === null ||
    !hasExactKeys(summary, [
      "changedPathCount",
      "changedSubjectCount",
      "uploadedObjectCount",
      "uploadedBytes",
    ]) ||
    Object.values(summary).some((count) => !Number.isSafeInteger(count) || (count as number) < 0)
  ) {
    return null;
  }
  return pending as PendingPush;
};

export const decodeCheckoutDescriptor = (value: unknown): CheckoutDescriptor | null => {
  const descriptor = asRecord(value);
  if (
    descriptor === null ||
    !hasExactKeys(descriptor, [
      "contract",
      "siteId",
      "checkoutId",
      "remoteRef",
      "observedCommit",
      "expectedRefCommit",
      "baseReleaseId",
      "materializedAt",
    ]) ||
    descriptor.contract !== "zeroy/checkout@1" ||
    typeof descriptor.siteId !== "string" ||
    descriptor.siteId.length === 0 ||
    typeof descriptor.checkoutId !== "string" ||
    descriptor.checkoutId.length === 0 ||
    typeof descriptor.remoteRef !== "string" ||
    !/^refs\/drafts\/[a-zA-Z0-9._@-]+\/[a-zA-Z0-9-]+$/.test(descriptor.remoteRef) ||
    (descriptor.observedCommit !== null &&
      (typeof descriptor.observedCommit !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(descriptor.observedCommit))) ||
    (descriptor.expectedRefCommit !== null &&
      (typeof descriptor.expectedRefCommit !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(descriptor.expectedRefCommit))) ||
    (descriptor.baseReleaseId !== null && typeof descriptor.baseReleaseId !== "string") ||
    typeof descriptor.materializedAt !== "string" ||
    !Number.isFinite(Date.parse(descriptor.materializedAt))
  ) {
    return null;
  }
  return descriptor as CheckoutDescriptor;
};

const descriptorPath = (path: Path.Path, root: string): string =>
  path.join(root, ".zeroy", "checkout.json");
const pendingPath = (path: Path.Path, root: string): string =>
  path.join(root, ".zeroy", "pending-push.json");
const conflictsPath = (path: Path.Path, root: string): string =>
  path.join(root, ".zeroy", "conflicts.json");

const decodeJson = <A>(label: string, encoded: string): Effect.Effect<A, ZeroYConnectorError> =>
  Effect.try({
    try: () => JSON.parse(encoded) as A,
    catch: () => failure(`${label} is not valid JSON.`, "zeroy_checkout_descriptor_invalid"),
  });

const readDescriptor = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* io(
      "Could not read checkout descriptor",
      fs.readFileString(descriptorPath(path, root)),
    );
    const decoded = yield* decodeJson<unknown>("Checkout descriptor", encoded);
    const descriptor = decodeCheckoutDescriptor(decoded);
    if (descriptor === null) {
      return yield* failure(
        "Checkout descriptor violates zeroy/checkout@1.",
        "zeroy_checkout_descriptor_invalid",
      );
    }
    return descriptor;
  });

const writeJson = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* io(
      "Could not create checkout metadata directory",
      fs.makeDirectory(path.dirname(file), { recursive: true }),
    );
    yield* io(
      "Could not write checkout metadata",
      fs.writeFileString(file, `${JSON.stringify(value, null, 2)}\n`),
    );
  });

const runCommand = (cwd: string, command: string, args: readonly string[]) =>
  Effect.callback<void, ZeroYConnectorError>((resume) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    child.once("error", (cause) =>
      resume(Effect.fail(failure(`${command} ${args[0] ?? ""} failed: ${String(cause)}`))),
    );
    child.once("exit", (code) =>
      resume(
        code === 0
          ? Effect.void
          : Effect.fail(failure(`${command} ${args[0] ?? ""} failed: ${error.trim()}`)),
      ),
    );
    return Effect.sync(() => child.kill("SIGTERM"));
  });

const runGit = (cwd: string, args: readonly string[]) => runCommand(cwd, "git", args);

const runCommandOutput = (cwd: string, command: string, args: readonly string[]) =>
  Effect.callback<string, ZeroYConnectorError>((resume) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    child.once("error", (cause) =>
      resume(Effect.fail(failure(`${command} ${args[0] ?? ""} failed: ${String(cause)}`))),
    );
    child.once("exit", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(failure(`${command} ${args[0] ?? ""} failed: ${error.trim()}`)),
      ),
    );
    return Effect.sync(() => child.kill("SIGTERM"));
  });

const runCommandStatus = (cwd: string, command: string, args: readonly string[]) =>
  Effect.callback<{ readonly code: number; readonly error: string }, ZeroYConnectorError>(
    (resume) => {
      const child = spawn(command, [...args], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        error += String(chunk);
      });
      child.once("error", (cause) =>
        resume(Effect.fail(failure(`${command} ${args[0] ?? ""} failed: ${String(cause)}`))),
      );
      child.once("exit", (code) =>
        resume(Effect.succeed({ code: code ?? 1, error: error.trim() })),
      );
      return Effect.sync(() => child.kill("SIGTERM"));
    },
  );

const zeroYCommitGitRef = (commit: ObjectHash): string =>
  `refs/zeroy/commits/${commit.slice("sha256:".length)}`;

const zeroYRemoteGitRef = (remoteRef: string): string =>
  `refs/zeroy/remote/${remoteRef.replace(/^refs\//, "")}`;

const mapZeroYGitRefs = (root: string, commit: ObjectHash, remoteRef: string, gitCommit: string) =>
  Effect.all([
    runGit(root, ["update-ref", zeroYCommitGitRef(commit), gitCommit]),
    runGit(root, ["update-ref", zeroYRemoteGitRef(remoteRef), gitCommit]),
  ]).pipe(Effect.asVoid);

const recordZeroYGitCommit = (
  root: string,
  message: string,
  commit: ObjectHash,
  tree: ObjectHash,
  baseReleaseId: string | null,
  remoteRef: string,
) =>
  Effect.gen(function* () {
    yield* runGit(root, ["add", "--all"]);
    yield* runGit(root, [
      "-c",
      "user.name=zeroY",
      "-c",
      "user.email=zeroy@local",
      "commit",
      "--allow-empty",
      "-m",
      `${message}\n\nzeroY-Commit: ${commit}\nzeroY-Tree: ${tree}\nzeroY-Base-Release: ${baseReleaseId ?? "none"}`,
    ]);
    const head = (yield* runCommandOutput(root, "git", ["rev-parse", "HEAD"])).trim();
    yield* mapZeroYGitRefs(root, commit, remoteRef, head);
    return head;
  });

const recordLocalZeroYGitCommit = (
  root: string,
  message: string,
  commit: ObjectHash,
  tree: ObjectHash,
  baseReleaseId: string | null,
) =>
  Effect.gen(function* () {
    yield* runGit(root, ["add", "--all"]);
    yield* runGit(root, [
      "-c",
      "user.name=zeroY",
      "-c",
      "user.email=zeroy@local",
      "commit",
      "--allow-empty",
      "-m",
      `${message}\n\nzeroY-Commit: ${commit}\nzeroY-Tree: ${tree}\nzeroY-Base-Release: ${baseReleaseId ?? "none"}`,
    ]);
    const head = (yield* runCommandOutput(root, "git", ["rev-parse", "HEAD"])).trim();
    yield* runGit(root, ["update-ref", zeroYCommitGitRef(commit), head]);
    return head;
  });

const gitChangedPaths = (root: string) =>
  Effect.all(
    [
      runCommandOutput(root, "git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"]),
      runCommandOutput(root, "git", ["ls-files", "--others", "--exclude-standard", "-z"]),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([tracked, untracked]) =>
      [...new Set(`${tracked}\0${untracked}`.split("\0"))]
        .filter((relative) => relative.length > 0)
        .filter(
          (relative) => relative !== ".zeroy/checkout.json" && !relative.startsWith(".zeroy/"),
        )
        .sort(),
    ),
  );

const runTextThreeWayMerge = (
  cwd: string,
  label: string,
  ours: string,
  base: string,
  remote: string,
) =>
  Effect.callback<{ readonly output: string; readonly conflicted: boolean }, ZeroYConnectorError>(
    (resume) => {
      const child = spawn(
        "git",
        [
          "merge-file",
          "--stdout",
          "-L",
          `${label} (ours)`,
          "-L",
          `${label} (base)`,
          "-L",
          `${label} (remote)`,
          ours,
          base,
          remote,
        ],
        {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      let error = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        error += String(chunk);
      });
      child.once("error", (cause) =>
        resume(Effect.fail(failure(`git merge-file failed: ${String(cause)}`))),
      );
      child.once("exit", (code) => {
        if (code === 0 || code === 1) {
          resume(Effect.succeed({ output, conflicted: code === 1 }));
          return;
        }
        resume(Effect.fail(failure(`git merge-file failed: ${error.trim()}`)));
      });
      return Effect.sync(() => child.kill("SIGTERM"));
    },
  );

const safeCheckoutLabel = (label: string): string =>
  label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 40) || "site";

const fetchObject = (
  active: ActiveSession,
  siteId: string,
  objectHash: string,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const site = yield* connection(active, siteId);
    const payload = yield* connectorGet(site, `site-objects/${objectHash}`, signal);
    const encoded = typeof payload.bytesBase64 === "string" ? payload.bytesBase64 : null;
    if (encoded === null)
      return yield* failure(
        "Connector returned SiteObject without bytes.",
        "zeroy_site_object_invalid",
      );
    const bytes = Buffer.from(encoded, "base64");
    if (payload.objectType !== "blob" || blobHash(bytes) !== objectHash) {
      return yield* failure(
        "Downloaded SiteObject bytes do not match their identity.",
        "zeroy_site_object_hash_mismatch",
      );
    }
    return bytes;
  });

type CheckoutManifestFile = {
  readonly path: string;
  readonly hash: ObjectHash;
  readonly mode: "file" | "executable";
};

type CheckoutManifest = {
  readonly commit: ObjectHash;
  readonly baseReleaseId: string | null;
  readonly files: ReadonlyMap<string, CheckoutManifestFile>;
};

const decodeCheckoutManifest = (payload: JsonRecord): CheckoutManifest | null => {
  const commit = typeof payload.commit === "string" ? payload.commit : "";
  if (!/^sha256:[a-f0-9]{64}$/.test(commit) || !Array.isArray(payload.files)) return null;
  const files = new Map<string, CheckoutManifestFile>();
  for (const value of payload.files) {
    const item = asRecord(value);
    const relative = item && typeof item.path === "string" ? item.path : "";
    const hash = item && typeof item.hash === "string" ? item.hash : "";
    const mode = item?.mode;
    if (
      !checkoutPathIsSafe(relative) ||
      !/^sha256:[a-f0-9]{64}$/.test(hash) ||
      (mode !== "file" && mode !== "executable") ||
      files.has(relative)
    )
      return null;
    files.set(relative, {
      path: relative,
      hash: hash as ObjectHash,
      mode,
    });
  }
  return {
    commit: commit as ObjectHash,
    baseReleaseId: typeof payload.baseReleaseId === "string" ? payload.baseReleaseId : null,
    files,
  };
};

const fetchCommitManifest = (
  active: ActiveSession,
  siteId: string,
  commit: ObjectHash,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const site = yield* connection(active, siteId);
    const payload = yield* connectorGet(
      site,
      `site-checkout?${new URLSearchParams({ source: "commit", commit }).toString()}`,
      signal,
    );
    const manifest = decodeCheckoutManifest(payload);
    if (manifest === null || manifest.commit !== commit)
      return yield* failure(
        "Connector returned an invalid exact-commit checkout manifest.",
        "zeroy_checkout_source_invalid",
      );
    return manifest;
  });

const fetchSiteCommit = (
  active: ActiveSession,
  siteId: string,
  commit: ObjectHash,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const site = yield* connection(active, siteId);
    const payload = yield* connectorGet(site, `site-commits/${commit}`, signal);
    const decoded = decodeSiteCommit(payload.commit);
    const actual = decoded._tag === "Success" ? commitHash(decoded.value) : null;
    if (decoded._tag === "Failure" || actual?._tag !== "Success" || actual.value !== commit)
      return yield* failure(
        "Connector SiteCommit bytes do not match their identity.",
        "zeroy_site_commit_hash_mismatch",
      );
    return decoded.value;
  });

const materializeRemoteGitCommit = (
  active: ActiveSession,
  siteId: string,
  root: string,
  commit: ObjectHash,
  signal: AbortSignal | undefined,
): Effect.Effect<string, ZeroYToolFailure, NodeServices> =>
  Effect.gen(function* () {
    const existing = yield* runCommandOutput(root, "git", [
      "rev-parse",
      "--verify",
      zeroYCommitGitRef(commit),
    ]).pipe(Effect.option);
    if (existing._tag === "Some") return existing.value.trim();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const [manifest, siteCommit] = yield* Effect.all(
      [
        fetchCommitManifest(active, siteId, commit, signal),
        fetchSiteCommit(active, siteId, commit, signal),
      ],
      { concurrency: 2 },
    );
    const parent = siteCommit.parents[0];
    const parentGit =
      parent === undefined
        ? null
        : yield* materializeRemoteGitCommit(active, siteId, root, parent, signal);
    const worktree = path.join(path.dirname(root), `.zeroy-git-materialize-${randomUUID()}`);
    yield* runGit(root, ["worktree", "add", "--detach", worktree, parentGit ?? "HEAD"]);
    const created = yield* Effect.gen(function* () {
      if (parentGit === null) {
        yield* runGit(worktree, ["checkout", "--orphan", `zeroy-root-${randomUUID()}`]);
      }
      for (const name of yield* io(
        "Could not read materialization worktree",
        fs.readDirectory(worktree),
      )) {
        if (name !== ".git")
          yield* io(
            "Could not clear materialization worktree",
            fs.remove(path.join(worktree, name), { recursive: true, force: true }),
          );
      }
      for (const file of manifest.files.values()) {
        const bytes = yield* fetchObject(active, siteId, file.hash, signal);
        const target = path.join(worktree, ...file.path.split("/"));
        yield* io(
          "Could not create materialized Git path",
          fs.makeDirectory(path.dirname(target), { recursive: true }),
        );
        yield* io("Could not write materialized Git file", fs.writeFile(target, bytes));
        yield* io(
          "Could not restore materialized Git mode",
          fs.chmod(target, file.mode === "executable" ? 0o755 : 0o644),
        );
      }
      yield* runGit(worktree, ["add", "--all"]);
      yield* runGit(worktree, [
        "-c",
        "user.name=zeroY",
        "-c",
        "user.email=zeroy@local",
        "commit",
        "--allow-empty",
        "-m",
        `${siteCommit.message}\n\nzeroY-Commit: ${commit}\nzeroY-Tree: ${siteCommit.tree}\nzeroY-Base-Release: ${siteCommit.baseReleaseId ?? "none"}`,
      ]);
      return (yield* runCommandOutput(worktree, "git", ["rev-parse", "HEAD"])).trim();
    }).pipe(
      Effect.ensuring(
        runGit(root, ["worktree", "remove", "--force", worktree]).pipe(Effect.ignore),
      ),
    );
    yield* runGit(root, ["update-ref", zeroYCommitGitRef(commit), created]);
    return created;
  });

const fetchChangedPaths = (
  active: ActiveSession,
  siteId: string,
  base: ObjectHash,
  commit: ObjectHash,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const site = yield* connection(active, siteId);
    const paths: string[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ base, commit, limit: "50" });
      if (cursor !== null) query.set("cursor", cursor);
      const payload = yield* connectorGet(site, `site-commit-diff?${query.toString()}`, signal);
      if (payload.contract !== "zeroy/site-commit-diff@1" || !Array.isArray(payload.items))
        return yield* failure(
          "Connector returned an invalid SiteCommit diff.",
          "zeroy_site_commit_diff_invalid",
        );
      for (const value of payload.items) {
        const item = asRecord(value);
        const relative = item && typeof item.path === "string" ? item.path : "";
        if (!checkoutPathIsSafe(relative))
          return yield* failure(
            "Connector SiteCommit diff contains an invalid path.",
            "zeroy_site_commit_diff_invalid",
          );
        paths.push(relative);
      }
      cursor =
        payload.hasMore === true && typeof payload.nextCursor === "string"
          ? payload.nextCursor
          : null;
    } while (cursor !== null);
    return [...new Set(paths)].sort();
  });

const readOptionalFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* io("Could not inspect checkout file", fs.exists(file));
    return exists ? yield* io("Could not read checkout file", fs.readFile(file)) : null;
  });

const workspaceBuildId = (value: unknown): string | null => {
  const build = asRecord(value);
  const buildId = build && typeof build.buildId === "string" ? build.buildId : null;
  return buildId && /^sha256:[a-f0-9]{64}$/.test(buildId) ? buildId : null;
};

const authoredSeedBytes = (value: unknown): Uint8Array | null => {
  const seed = asRecord(value);
  if (seed?.encoding === "utf8" && typeof seed.content === "string")
    return new TextEncoder().encode(seed.content);
  if (seed?.encoding === "base64" && typeof seed.bytesBase64 === "string") {
    const bytes = Buffer.from(seed.bytesBase64, "base64");
    return bytes.toString("base64") === seed.bytesBase64 ? bytes : null;
  }
  return null;
};

const replaceWorkspaceProjection = (
  active: ActiveSession,
  siteId: string,
  root: string,
  commit: ObjectHash,
  buildId: string,
  reviewSource: "baseline" | "owned-draft",
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const site = yield* connection(active, siteId);
    const reviewParameters = new URLSearchParams({ commit, buildId });
    const reviewEndpoint =
      reviewSource === "baseline" ? "site-review/baseline-workspace" : "site-review/workspace";
    const [response, reviewResponse] = yield* Effect.all([
      connectorGet(site, `site-builds/${buildId}/workspace`, signal),
      connectorGet(site, `${reviewEndpoint}?${reviewParameters.toString()}`, signal),
    ]);
    const files = asRecord(response.files);
    const authoredSeeds = asRecord(response.authoredSeeds);
    const reviewFiles = asRecord(reviewResponse.files);
    if (files === null || authoredSeeds === null || reviewFiles === null)
      return yield* failure(
        "Connector returned an invalid Workspace or Review projection.",
        "zeroy_workspace_projection_invalid",
      );
    const metadata = path.join(root, ".zeroy");
    const next = path.join(root, `.zeroy.next-${randomUUID()}`);
    const previous = path.join(root, `.zeroy.previous-${randomUUID()}`);
    yield* io(
      "Could not create WorkspaceProjection staging directory",
      fs.makeDirectory(next, { recursive: true }),
    );
    for (const [projectedPath, value] of Object.entries({ ...files, ...reviewFiles })) {
      if (!projectedPath.startsWith(".zeroy/") || !checkoutPathIsSafe(projectedPath))
        return yield* failure(
          `WorkspaceProjection contains an invalid path: ${projectedPath}.`,
          "zeroy_workspace_projection_invalid",
        );
      const relative = projectedPath.slice(".zeroy/".length);
      const target = path.join(next, ...relative.split("/"));
      yield* io(
        "Could not create WorkspaceProjection path",
        fs.makeDirectory(path.dirname(target), { recursive: true }),
      );
      const encoded = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
      yield* io("Could not write WorkspaceProjection", fs.writeFileString(target, encoded));
    }
    for (const name of ["checkout.json", "pending-push.json", "conflicts.json"]) {
      const bytes = yield* readOptionalFile(path.join(metadata, name));
      if (bytes !== null)
        yield* io(
          "Could not preserve checkout metadata",
          fs.writeFile(path.join(next, name), bytes),
        );
    }
    const exists = yield* io("Could not inspect existing WorkspaceProjection", fs.exists(metadata));
    if (exists)
      yield* io("Could not stage prior WorkspaceProjection", fs.rename(metadata, previous));
    yield* io("Could not activate WorkspaceProjection", fs.rename(next, metadata));
    if (exists)
      yield* io(
        "Could not remove prior WorkspaceProjection",
        fs.remove(previous, { recursive: true, force: true }),
      );
    for (const [seedPath, value] of Object.entries(authoredSeeds)) {
      const bytes = authoredSeedBytes(value);
      if (seedPath.startsWith(".zeroy/") || !checkoutPathIsSafe(seedPath) || bytes === null)
        return yield* failure(
          `WorkspaceProjection contains an invalid authored seed: ${seedPath}.`,
          "zeroy_workspace_projection_invalid",
        );
      const target = path.join(root, ...seedPath.split("/"));
      if (yield* io("Could not inspect authored seed", fs.exists(target))) continue;
      yield* io(
        "Could not create authored seed directory",
        fs.makeDirectory(path.dirname(target), { recursive: true }),
      );
      yield* io("Could not write authored seed", fs.writeFile(target, bytes));
    }
  });

export const checkoutTool = (
  active: ActiveSession,
  input: CheckoutInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY checkout",
      "Materializing one immutable SiteCommit as a local working tree",
      [["Site", input.siteId]],
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const site = yield* connection(active, input.siteId);
        const parameters = new URLSearchParams();
        if (input.source === "active-release") parameters.set("source", "active-release");
        else {
          parameters.set("source", "draft-ref");
          parameters.set("draftRef", input.draftRef);
        }
        const source = yield* connectorGet(site, `site-checkout?${parameters.toString()}`, signal);
        const files = Array.isArray(source.files) ? source.files : null;
        if (files === null)
          return yield* failure(
            "Connector returned an invalid checkout source.",
            "zeroy_checkout_source_invalid",
          );
        const checkoutId = randomUUID();
        const root = path.join(
          active.context.cwd || process.cwd(),
          ".zeroy-checkouts",
          `${safeCheckoutLabel(site.label)}-${checkoutId}`,
        );
        yield* io(
          "Could not create checkout directory",
          fs.makeDirectory(root, { recursive: true }),
        );
        for (const item of files) {
          const file = asRecord(item);
          const relative = file && typeof file.path === "string" ? file.path : "";
          const hash = file && typeof file.hash === "string" ? file.hash : "";
          if (!checkoutPathIsSafe(relative) || !/^sha256:[a-f0-9]{64}$/.test(hash))
            return yield* failure(
              "Connector checkout manifest contains an invalid file.",
              "zeroy_checkout_source_invalid",
            );
          const bytes = yield* fetchObject(active, input.siteId, hash, signal);
          const target = path.join(root, ...relative.split("/"));
          yield* io(
            "Could not create checkout path",
            fs.makeDirectory(path.dirname(target), { recursive: true }),
          );
          yield* io("Could not write checkout file", fs.writeFile(target, bytes));
        }
        const observedCommit =
          typeof source.commit === "string" ? (source.commit as ObjectHash) : null;
        const descriptor: CheckoutDescriptor = {
          contract: "zeroy/checkout@1",
          siteId: input.siteId,
          checkoutId,
          remoteRef:
            input.source === "active-release"
              ? `refs/drafts/connector/${checkoutId}`
              : input.draftRef,
          observedCommit,
          expectedRefCommit: input.source === "active-release" ? null : observedCommit,
          baseReleaseId: typeof source.baseReleaseId === "string" ? source.baseReleaseId : null,
          materializedAt: DateTime.formatIso(yield* DateTime.now),
        };
        const buildId = workspaceBuildId(source.build);
        if (buildId === null)
          return yield* failure(
            "Connector checkout source did not identify its BuildResult.",
            "zeroy_build_result_missing",
          );
        yield* writeJson(descriptorPath(path, root), descriptor);
        yield* runGit(root, ["init"]);
        yield* io(
          "Could not exclude derived WorkspaceProjection from local Git",
          fs.writeFileString(path.join(root, ".git", "info", "exclude"), ".zeroy/\n"),
        );
        if (observedCommit !== null && typeof source.tree === "string")
          yield* recordZeroYGitCommit(
            root,
            "zeroY checkout baseline",
            observedCommit,
            source.tree as ObjectHash,
            descriptor.baseReleaseId,
            descriptor.remoteRef,
          );
        if (observedCommit === null)
          return yield* failure(
            "Connector checkout source did not identify its exact SiteCommit.",
            "zeroy_site_commit_missing",
          );
        yield* replaceWorkspaceProjection(
          active,
          input.siteId,
          root,
          observedCommit,
          buildId,
          input.source === "active-release" ? "baseline" : "owned-draft",
          signal,
        );
        return result(
          text({
            checkoutId,
            path: root,
            commit: observedCommit?.slice(0, 19) ?? null,
            fileCount: files.length,
          }),
          "zeroY checkout ready",
          "Edit this local checkout, then push each coherent repair slice for administrator preview and review.",
          [
            ["Site", input.siteId],
            ["Checkout", checkoutId],
            ["Path", root],
          ],
        );
      }),
    ),
  );

const normalizedFileBytes = (
  relative: string,
  bytes: Uint8Array,
): Effect.Effect<Uint8Array, ZeroYConnectorError> => {
  const lower = relative.toLowerCase();
  if (lower.endsWith(".json"))
    return canonicalJsonDocument(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError((error) => failure(error.message, `zeroy_${error.code}`)),
    );
  if (
    [".php", ".css", ".js", ".mjs", ".cjs", ".html", ".md", ".txt", ".svg"].some((extension) =>
      lower.endsWith(extension),
    )
  ) {
    return Effect.succeed(
      new TextEncoder().encode(normalizeCheckoutText(new TextDecoder().decode(bytes))),
    );
  }
  return Effect.succeed(bytes);
};

type TreeNode = {
  directories: Map<string, TreeNode>;
  files: Map<string, { bytes: Uint8Array; mode: "file" | "executable" }>;
};
const node = (): TreeNode => ({ directories: new Map(), files: new Map() });

const scanCheckout = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tree = node();
    const paths: string[] = [];
    const visit = (
      directory: string,
      relativeRoot: string,
    ): Effect.Effect<void, ZeroYConnectorError, NodeServices> =>
      Effect.gen(function* () {
        const names = yield* io("Could not read checkout directory", fs.readDirectory(directory));
        for (const name of names.sort()) {
          if (relativeRoot === "" && (name === ".git" || name === ".zeroy")) continue;
          const relative = relativeRoot === "" ? name : `${relativeRoot}/${name}`;
          if (!checkoutPathIsSafe(relative))
            return yield* failure(
              `Checkout path is unsafe: ${relative}.`,
              "zeroy_checkout_path_invalid",
            );
          const absolute = path.join(directory, name);
          const info = yield* io("Could not stat checkout path", fs.stat(absolute));
          if (info.type === "Directory") {
            yield* visit(absolute, relative);
          } else if (info.type === "File") {
            if (
              !["site.json", "artifacts", "content", "locales", "media"].includes(
                relative.split("/")[0] ?? "",
              )
            )
              return yield* failure(
                `Checkout path is outside the SiteCheckout contract: ${relative}.`,
                "zeroy_checkout_path_outside_contract",
              );
            paths.push(relative);
            const bytes = yield* normalizedFileBytes(
              relative,
              yield* io("Could not read checkout file", fs.readFile(absolute)),
            );
            let cursor = tree;
            const segments = relative.split("/");
            const filename = segments.pop();
            if (!filename) return yield* failure("Checkout path has no filename.");
            for (const segment of segments) {
              const child = cursor.directories.get(segment) ?? node();
              cursor.directories.set(segment, child);
              cursor = child;
            }
            cursor.files.set(filename, {
              bytes,
              mode: info.mode !== undefined && (info.mode & 0o111) !== 0 ? "executable" : "file",
            });
          } else
            return yield* failure(
              `Checkout contains a non-file entry: ${relative}.`,
              "zeroy_checkout_entry_invalid",
            );
        }
      });
    yield* visit(root, "");
    const objects = new Map<ObjectHash, StoredObject>();
    const encode = (
      current: TreeNode,
    ): Effect.Effect<ObjectHash, ZeroYConnectorError, NodeServices> =>
      Effect.gen(function* () {
        const entries: SiteTreeEntry[] = [];
        for (const [name, child] of current.directories)
          entries.push({ name, kind: "tree", hash: yield* encode(child), mode: "file" });
        for (const [name, file] of current.files) {
          const hash = blobHash(file.bytes);
          objects.set(hash, { objectHash: hash, objectType: "blob", bytes: file.bytes });
          entries.push({ name, kind: "blob", hash, mode: file.mode });
        }
        const bytes = yield* fromSiteObjectResult(treeBytes(entries));
        const hash = yield* fromSiteObjectResult(treeHash(entries));
        objects.set(hash, { objectHash: hash, objectType: "tree", bytes });
        return hash;
      });
    return { rootTree: yield* encode(tree), objects, paths: paths.sort() };
  });

const locateCheckout = (active: ActiveSession, checkoutId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = path.join(active.context.cwd || process.cwd(), ".zeroy-checkouts");
    const names = yield* io("Could not list zeroY checkouts", fs.readDirectory(base));
    for (const name of names) {
      const root = path.join(base, name);
      const descriptor = yield* readDescriptor(root).pipe(Effect.option);
      if (descriptor._tag === "Some" && descriptor.value.checkoutId === checkoutId)
        return { root, descriptor: descriptor.value };
    }
    return yield* failure(
      `Checkout ${checkoutId} was not found under ${base}.`,
      "zeroy_checkout_missing",
    );
  });

const readPending = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* fs.readFileString(pendingPath(path, root)).pipe(Effect.option);
    if (encoded._tag === "None") return null;
    const parsed = yield* decodeJson<unknown>("Pending push envelope", encoded.value);
    const pending = decodePendingPush(parsed);
    return pending === null
      ? yield* failure(
          "Pending push envelope violates zeroy/pending-push@3.",
          "zeroy_pending_push_invalid",
        )
      : pending;
  });

const manifestFileBytes = (
  active: ActiveSession,
  siteId: string,
  file: CheckoutManifestFile | undefined,
  signal: AbortSignal | undefined,
) => (file === undefined ? Effect.succeed(null) : fetchObject(active, siteId, file.hash, signal));

const writeWorkingFile = (
  root: string,
  relative: string,
  bytes: Uint8Array | null,
  mode: "file" | "executable" = "file",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(root, ...relative.split("/"));
    if (bytes === null) {
      yield* io("Could not apply rebased deletion", fs.remove(target, { force: true }));
      return;
    }
    yield* io(
      "Could not create rebased checkout path",
      fs.makeDirectory(path.dirname(target), { recursive: true }),
    );
    yield* io("Could not write rebased checkout file", fs.writeFile(target, bytes));
    yield* io(
      "Could not restore rebased checkout mode",
      fs.chmod(target, mode === "executable" ? 0o755 : 0o644),
    );
  });

const mergeOverlappingFile = (
  active: ActiveSession,
  siteId: string,
  root: string,
  relative: string,
  baseFile: CheckoutManifestFile | undefined,
  remoteFile: CheckoutManifestFile | undefined,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ours = yield* readOptionalFile(path.join(root, ...relative.split("/")));
    const base = yield* manifestFileBytes(active, siteId, baseFile, signal);
    const remote = yield* manifestFileBytes(active, siteId, remoteFile, signal);
    const mode = remoteFile?.mode ?? baseFile?.mode ?? "file";
    if (ours !== null && remote !== null && Buffer.from(ours).equals(Buffer.from(remote))) {
      yield* writeWorkingFile(root, relative, ours, mode);
      return [] as readonly MergeConflict[];
    }
    if (base !== null && ours === null && remote !== null) {
      if (Buffer.from(base).equals(Buffer.from(remote))) {
        yield* writeWorkingFile(root, relative, null);
        return [] as readonly MergeConflict[];
      }
      return [{ path: relative, kind: "delete-modify" }] as readonly MergeConflict[];
    }
    if (base !== null && ours !== null && remote === null) {
      if (Buffer.from(base).equals(Buffer.from(ours))) {
        yield* writeWorkingFile(root, relative, null);
        return [] as readonly MergeConflict[];
      }
      return [{ path: relative, kind: "delete-modify" }] as readonly MergeConflict[];
    }
    if (base === null || ours === null || remote === null) {
      return [
        { path: relative, kind: incompleteMergeConflictKind(relative) },
      ] as readonly MergeConflict[];
    }
    if (relative.toLowerCase().endsWith(".json")) {
      const decoded = yield* Effect.try({
        try: () => ({
          base: decodeJsonDocument(base),
          ours: decodeJsonDocument(ours),
          remote: decodeJsonDocument(remote),
        }),
        catch: () => failure(`Could not decode JSON merge inputs for ${relative}.`),
      });
      const merged = mergeJsonDocuments(decoded.base, decoded.ours, decoded.remote);
      yield* writeWorkingFile(root, relative, encodeJsonDocument(merged.value), mode);
      return merged.conflicts.map(
        (fieldPath): MergeConflict => ({ path: relative, fieldPath, kind: "content" }),
      );
    }
    if (!isMergeableTextPath(relative))
      return [{ path: relative, kind: "binary" }] as readonly MergeConflict[];
    const mergeRoot = path.join(root, ".zeroy", "merge", randomUUID());
    yield* io("Could not create merge workspace", fs.makeDirectory(mergeRoot, { recursive: true }));
    const oursPath = path.join(mergeRoot, "ours");
    const basePath = path.join(mergeRoot, "base");
    const remotePath = path.join(mergeRoot, "remote");
    const merged = yield* Effect.gen(function* () {
      yield* io("Could not write merge input", fs.writeFile(oursPath, ours));
      yield* io("Could not write merge input", fs.writeFile(basePath, base));
      yield* io("Could not write merge input", fs.writeFile(remotePath, remote));
      return yield* runTextThreeWayMerge(root, relative, oursPath, basePath, remotePath);
    }).pipe(
      Effect.ensuring(fs.remove(mergeRoot, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
    yield* writeWorkingFile(root, relative, normalizedTextBytes(merged.output), mode);
    return merged.conflicted
      ? ([{ path: relative, kind: "content" }] as readonly MergeConflict[])
      : ([] as readonly MergeConflict[]);
  });

export const rebaseCheckout = (
  active: ActiveSession,
  siteId: string,
  root: string,
  descriptor: CheckoutDescriptor,
  current: ObjectHash,
  remotePaths: readonly string[],
  localPaths: readonly string[],
  signal: AbortSignal | undefined,
  expectedRefCommit: ObjectHash = current,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (descriptor.observedCommit === null)
      return yield* failure(
        "Checkout has no observed commit for three-way comparison.",
        "zeroy_checkout_base_missing",
      );
    const [base, remote, remoteGit] = yield* Effect.all(
      [
        fetchCommitManifest(active, siteId, descriptor.observedCommit, signal),
        fetchCommitManifest(active, siteId, current, signal),
        materializeRemoteGitCommit(active, siteId, root, current, signal),
      ],
      { concurrency: 3 },
    );
    const baseGit = (yield* runCommandOutput(root, "git", [
      "rev-parse",
      "--verify",
      zeroYCommitGitRef(descriptor.observedCommit),
    ])).trim();
    const local = new Set(localPaths);
    const conflicts: MergeConflict[] = [];
    for (const relative of remotePaths) {
      const remoteFile = remote.files.get(relative);
      if (!local.has(relative)) {
        const bytes = yield* manifestFileBytes(active, siteId, remoteFile, signal);
        yield* writeWorkingFile(root, relative, bytes, remoteFile?.mode);
        continue;
      }
      conflicts.push(
        ...(yield* mergeOverlappingFile(
          active,
          siteId,
          root,
          relative,
          base.files.get(relative),
          remoteFile,
          signal,
        )),
      );
    }
    yield* runGit(root, ["add", "--all"]);
    yield* runGit(root, [
      "-c",
      "user.name=zeroY",
      "-c",
      "user.email=zeroy@local",
      "commit",
      "--amend",
      "--no-edit",
    ]);
    const localGit = (yield* runCommandOutput(root, "git", ["rev-parse", "HEAD"])).trim();
    const rebased = yield* runCommandStatus(root, "git", [
      "-c",
      "merge.conflictStyle=diff3",
      "rebase",
      "--onto",
      remoteGit,
      baseGit,
      localGit,
    ]);
    const expectedRefGit = (yield* runCommandOutput(root, "git", [
      "rev-parse",
      "--verify",
      zeroYCommitGitRef(expectedRefCommit),
    ])).trim();
    yield* runGit(root, ["update-ref", zeroYRemoteGitRef(descriptor.remoteRef), expectedRefGit]);
    let rebaseCompleted = rebased.code === 0;
    if (!rebaseCompleted) {
      const initiallyUnmerged = (yield* runCommandOutput(root, "git", [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]))
        .split("\0")
        .filter((relative) => relative.length > 0);
      const semanticConflictPaths = new Set(conflicts.map((conflict) => conflict.path));
      for (const relative of initiallyUnmerged) {
        if (!semanticConflictPaths.has(relative))
          yield* runGit(root, ["checkout", localGit, "--", relative]);
      }
      const unmerged = (yield* runCommandOutput(root, "git", [
        "diff",
        "--name-only",
        "--diff-filter=U",
        "-z",
      ]))
        .split("\0")
        .filter((relative) => relative.length > 0);
      if (unmerged.length === 0 && conflicts.length === 0) {
        yield* runGit(root, ["-c", "core.editor=true", "rebase", "--continue"]);
        rebaseCompleted = true;
      }
      for (const relative of unmerged) {
        if (!conflicts.some((conflict) => conflict.path === relative))
          conflicts.push({ path: relative, kind: "content" });
      }
      if (!rebaseCompleted && conflicts.length === 0)
        return yield* failure(
          `Git rebase failed without a conflict index: ${rebased.error}`,
          "zeroy_checkout_rebase_failed",
        );
    }
    if (rebaseCompleted) {
      if (conflicts.length > 0)
        return yield* failure(
          "Semantic merge reported a conflict but Git did not preserve an unmerged index.",
          "zeroy_checkout_conflict_index_missing",
        );
      yield* runGit(root, ["reset", "--mixed", remoteGit]);
    }
    yield* writeJson(descriptorPath(path, root), {
      ...descriptor,
      observedCommit: current,
      expectedRefCommit,
      baseReleaseId: remote.baseReleaseId,
      materializedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return conflicts;
  });

const finishPendingGitRebase = (root: string, observedCommit: ObjectHash | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitDirectory = path.join(root, ".git");
    const inProgress =
      (yield* io(
        "Could not inspect Git rebase state",
        fs.exists(path.join(gitDirectory, "rebase-merge")),
      )) ||
      (yield* io(
        "Could not inspect Git rebase state",
        fs.exists(path.join(gitDirectory, "rebase-apply")),
      ));
    if (!inProgress) return;
    if (observedCommit === null)
      return yield* failure(
        "Git rebase is in progress but checkout has no observed zeroY commit.",
        "zeroy_checkout_base_missing",
      );
    yield* runGit(root, ["add", "--all"]);
    yield* runGit(root, ["-c", "core.editor=true", "rebase", "--continue"]);
    const remoteGit = (yield* runCommandOutput(root, "git", [
      "rev-parse",
      "--verify",
      zeroYCommitGitRef(observedCommit),
    ])).trim();
    yield* runGit(root, ["reset", "--mixed", remoteGit]);
  });

export const pushTool = (
  active: ActiveSession,
  input: PushInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYToolFailure, NodeServices> =>
  withSiteMutationGate(
    active,
    input.siteId,
    withLivePresentation(
      active,
      "zeroY push",
      "Publishing one content-addressed SiteCommit outside the model context",
      [["Site", input.siteId]],
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const site = yield* connection(active, input.siteId);
        const located = yield* locateCheckout(active, input.checkoutId);
        if (located.descriptor.siteId !== input.siteId)
          return yield* failure(
            "Checkout belongs to a different site.",
            "zeroy_checkout_site_mismatch",
          );
        for (let attempt = 0; attempt < 4; attempt++) {
          const descriptor =
            attempt === 0 ? located.descriptor : yield* readDescriptor(located.root);
          if (
            yield* io(
              "Could not inspect checkout conflicts",
              fs.exists(conflictsPath(path, located.root)),
            )
          )
            return yield* failure(
              "Checkout still has unresolved .zeroy/conflicts.json. Resolve the listed files and field paths, then delete the conflict fact before pushing.",
              "zeroy_checkout_conflict_unresolved",
            );
          yield* finishPendingGitRebase(located.root, descriptor.observedCommit);
          const scan = yield* scanCheckout(located.root);
          const changedPaths = yield* gitChangedPaths(located.root);
          yield* Effect.forEach(
            scan.paths.filter((relative) => relative.toLowerCase().endsWith(".php")),
            (relative) => runCommand(located.root, "php", ["-l", relative]),
            { concurrency: 4 },
          );
          const localValidation = yield* validateWorkspaceDocuments(located.root, scan.paths).pipe(
            Effect.mapError((cause) =>
              failure(`Could not validate projected workspace contracts: ${String(cause)}`),
            ),
          );
          if (localValidation.failures.length > 0) {
            return yield* new ZeroYConnectorError({
              code: "zeroy_workspace_contract_invalid",
              status: 400,
              message:
                "Authored JSON violates the checkout's concrete WorkspaceContracts. Repair the listed files before pushing.",
              data: {
                failures: localValidation.failures.slice(0, 20),
                failureCount: localValidation.failures.length,
              },
            });
          }
          const existingPending = yield* readPending(located.root);
          if (
            existingPending !== null &&
            (existingPending.rootTree !== scan.rootTree ||
              existingPending.message !== (input.message ?? ""))
          ) {
            return yield* failure(
              "An unresolved push exists for different checkout bytes. Retry the original push before editing or pushing again.",
              "zeroy_pending_push_conflict",
            );
          }
          const commit: SiteCommit =
            existingPending !== null
              ? existingPending.commit
              : changedPaths.length === 0 && descriptor.observedCommit !== null
                ? yield* connectorGet(
                    site,
                    `site-commits/${descriptor.observedCommit}`,
                    signal,
                  ).pipe(
                    Effect.flatMap((payload) => {
                      const decoded = decodeSiteCommit(payload.commit);
                      if (decoded._tag === "Failure")
                        return Effect.fail(
                          failure(
                            "Connector returned an invalid SiteCommit.",
                            "zeroy_site_commit_invalid",
                          ),
                        );
                      const actual = commitHash(decoded.value);
                      return actual._tag === "Success" && actual.value === descriptor.observedCommit
                        ? Effect.succeed(decoded.value)
                        : Effect.fail(
                            failure(
                              "Connector SiteCommit bytes do not match their identity.",
                              "zeroy_site_commit_hash_mismatch",
                            ),
                          );
                    }),
                  )
                : {
                    contract: "zeroy/site-commit@1",
                    tree: scan.rootTree,
                    parents: descriptor.observedCommit === null ? [] : [descriptor.observedCommit],
                    baseReleaseId: descriptor.baseReleaseId,
                    author: {
                      principal: `site:${input.siteId}`,
                      actorSessionId: active.draftActorId,
                    },
                    message: input.message ?? "",
                    createdAt: DateTime.formatIso(yield* DateTime.now),
                  };
          const commitId =
            existingPending?.commitHash ??
            (changedPaths.length === 0 && descriptor.observedCommit !== null
              ? descriptor.observedCommit
              : yield* fromSiteObjectResult(commitHash(commit)));
          if (existingPending === null && changedPaths.length > 0) {
            yield* recordLocalZeroYGitCommit(
              located.root,
              `zeroY push: ${commitId.slice(0, 19)}`,
              commitId,
              scan.rootTree,
              descriptor.baseReleaseId,
            );
          }
          const hashes = [...scan.objects.keys()];
          const want = yield* connectorPost(site, "site-objects/have", { hashes }, signal);
          const missing = Array.isArray(want.missing)
            ? want.missing.filter((hash): hash is string => typeof hash === "string")
            : [];
          let uploadedBytes = 0;
          for (let index = 0; index < missing.length; index += 20) {
            const batch = yield* Effect.forEach(missing.slice(index, index + 20), (hash) => {
              const object = scan.objects.get(hash as ObjectHash);
              if (!object)
                return Effect.fail(
                  failure(
                    `Connector requested unknown object ${hash}.`,
                    "zeroy_site_object_want_invalid",
                  ),
                );
              uploadedBytes += object.bytes.byteLength;
              return Effect.succeed({
                objectHash: object.objectHash,
                objectType: object.objectType,
                bytesBase64: Buffer.from(object.bytes).toString("base64"),
              });
            });
            yield* connectorPost(site, "site-objects", { objects: batch }, signal);
          }
          yield* connectorPost(site, "site-commits", { commitHash: commitId, commit }, signal);
          const changeSummary = existingPending?.changeSummary ?? {
            changedPathCount: changedPaths.length,
            changedSubjectCount: changedPaths.filter(
              (value) => value.startsWith("content/") || value.startsWith("locales/"),
            ).length,
            uploadedObjectCount: missing.length,
            uploadedBytes,
          };
          const request = {
            checkoutId: input.checkoutId,
            refName: descriptor.remoteRef,
            expectedCommit: descriptor.expectedRefCommit,
            commitHash: commitId,
            message: input.message ?? "",
            changeSummary,
          };
          const requestHash =
            existingPending?.requestHash ?? (yield* fromSiteObjectResult(pushRequestHash(request)));
          const pending: PendingPush = existingPending ?? {
            contract: "zeroy/pending-push@3",
            commandId: randomUUID(),
            requestHash,
            commitHash: commitId,
            commit,
            expectedCommit: descriptor.expectedRefCommit,
            rootTree: scan.rootTree,
            message: input.message ?? "",
            changeSummary,
          };
          yield* writeJson(pendingPath(path, located.root), pending);
          let receipt = yield* connectorPost(
            site,
            "site-push",
            { commandId: pending.commandId, requestHash: pending.requestHash, ...request },
            signal,
            active.draftActorId,
          ).pipe(
            Effect.catchTag("ZeroYConnectorError", (error) => {
              if (error.code === "zeroy_active_site_release_changed")
                return Effect.gen(function* () {
                  if (descriptor.observedCommit === null)
                    return yield* failure(
                      "Active SiteRelease advanced but checkout has no merge base.",
                      "zeroy_checkout_base_missing",
                    );
                  const payload = yield* connectorGet(site, "site-checkout", signal);
                  const remote = decodeCheckoutManifest(payload);
                  if (remote === null)
                    return yield* failure(
                      "Connector returned an invalid active SiteCheckout manifest.",
                      "zeroy_checkout_source_invalid",
                    );
                  const remotePaths = yield* fetchChangedPaths(
                    active,
                    input.siteId,
                    descriptor.observedCommit,
                    remote.commit,
                    signal,
                  );
                  const conflicts = yield* rebaseCheckout(
                    active,
                    input.siteId,
                    located.root,
                    descriptor,
                    remote.commit,
                    remotePaths,
                    changedPaths,
                    signal,
                    commitId,
                  );
                  yield* io(
                    "Could not terminate superseded pending push envelope",
                    fs.remove(pendingPath(path, located.root), { force: true }),
                  );
                  if (conflicts.length > 0) {
                    yield* writeJson(conflictsPath(path, located.root), {
                      contract: "zeroy/checkout-conflicts@1",
                      base: descriptor.observedCommit,
                      remote: remote.commit,
                      changedPathCount: remotePaths.length,
                      changedPaths: remotePaths,
                      conflicts,
                    });
                    return yield* new ZeroYConnectorError({
                      code: "zeroy_checkout_conflict",
                      message:
                        "Active SiteRelease advanced. Non-conflicting changes were rebased locally and conflicts were written to .zeroy/conflicts.json.",
                      status: 409,
                      data: { currentCommit: remote.commit, changedPaths: remotePaths, conflicts },
                    });
                  }
                  return { contract: "zeroy/internal-rebase-retry@1" };
                });
              if (error.code !== "zeroy_remote_ref_changed") return Effect.fail(error);
              return Effect.gen(function* () {
                const current = error.data?.currentCommit;
                const remotePaths = Array.isArray(error.data?.changedPaths)
                  ? error.data.changedPaths.filter(
                      (value): value is string =>
                        typeof value === "string" && checkoutPathIsSafe(value),
                    )
                  : [];
                const changedCount = Number(error.data?.changedPathCount ?? -1);
                const complete =
                  typeof current === "string" &&
                  /^sha256:[a-f0-9]{64}$/.test(current) &&
                  changedCount === remotePaths.length;
                if (!complete) {
                  yield* writeJson(path.join(located.root, ".zeroy", "conflicts.json"), {
                    contract: "zeroy/checkout-conflicts@1",
                    base: descriptor.observedCommit,
                    remote: typeof current === "string" ? current : null,
                    changedPathCount: changedCount,
                    changedPaths: remotePaths,
                    conflicts: [
                      {
                        path: null,
                        kind: "remote-diff-truncated",
                      },
                    ],
                  });
                  yield* io(
                    "Could not clear resolved pending push envelope",
                    fs.remove(pendingPath(path, located.root), { force: true }),
                  );
                  return yield* new ZeroYConnectorError({
                    code: "zeroy_checkout_conflict",
                    message:
                      "DraftRef changed and local edits overlap or the remote diff is truncated. Resolve .zeroy/conflicts.json by checking out the remote DraftRef and applying the local patch.",
                    status: 409,
                    data: {
                      currentCommit: typeof current === "string" ? current : null,
                      changedPathCount: changedCount,
                      changedPaths: remotePaths,
                      conflicts: [{ path: null, kind: "remote-diff-truncated" }],
                    },
                  });
                }
                const conflicts = yield* rebaseCheckout(
                  active,
                  input.siteId,
                  located.root,
                  descriptor,
                  current as ObjectHash,
                  remotePaths,
                  changedPaths,
                  signal,
                );
                yield* io(
                  "Could not clear resolved pending push envelope",
                  fs.remove(pendingPath(path, located.root), { force: true }),
                );
                if (conflicts.length > 0) {
                  yield* writeJson(conflictsPath(path, located.root), {
                    contract: "zeroy/checkout-conflicts@1",
                    base: descriptor.observedCommit,
                    remote: current,
                    changedPathCount: changedCount,
                    changedPaths: remotePaths,
                    conflicts,
                  });
                  return yield* new ZeroYConnectorError({
                    code: "zeroy_checkout_conflict",
                    message:
                      "DraftRef advanced. Non-conflicting changes were rebased locally and conflicts were written to .zeroy/conflicts.json. Resolve them, delete the conflict fact, and retry the push.",
                    status: 409,
                    data: { currentCommit: current, changedPaths: remotePaths, conflicts },
                  });
                }
                return { contract: "zeroy/internal-rebase-retry@1" };
              });
            }),
          );
          if (receipt.contract === "zeroy/internal-rebase-retry@1") continue;
          const acceptedReceipt = receipt as JsonRecord;
          const preview = asRecord(acceptedReceipt.preview);
          const browserChallenge = preview === null ? null : asRecord(preview.browserVerification);
          if (
            preview !== null &&
            typeof preview.releaseId === "string" &&
            browserChallenge !== null
          ) {
            const browserEvidence = yield* verifyBrowserChallenge(
              browserChallenge as never,
              signal,
            );
            receipt = yield* connectorPost(
              site,
              "site-push/finalize",
              {
                commandId: pending.commandId,
                requestHash: pending.requestHash,
                releaseId: preview.releaseId,
                browserEvidence,
              },
              signal,
              active.draftActorId,
            );
          }
          const next: CheckoutDescriptor = {
            ...descriptor,
            observedCommit: commitId,
            expectedRefCommit: commitId,
            baseReleaseId:
              asRecord((receipt as JsonRecord).release) &&
              typeof asRecord((receipt as JsonRecord).release)?.releaseId === "string"
                ? (asRecord((receipt as JsonRecord).release)?.releaseId as string)
                : descriptor.baseReleaseId,
            materializedAt: DateTime.formatIso(yield* DateTime.now),
          };
          const buildId = workspaceBuildId((receipt as JsonRecord).build);
          if (buildId === null)
            return yield* failure(
              "Push receipt did not identify its exact BuildResult.",
              "zeroy_build_result_missing",
            );
          yield* replaceWorkspaceProjection(
            active,
            input.siteId,
            located.root,
            commitId,
            buildId,
            "owned-draft",
            signal,
          );
          yield* writeJson(descriptorPath(path, located.root), next);
          yield* io(
            "Could not clear pending push envelope",
            fs.remove(pendingPath(path, located.root), { force: true }),
          );
          const acceptedGitCommit = (yield* runCommandOutput(located.root, "git", [
            "rev-parse",
            "HEAD",
          ])).trim();
          yield* mapZeroYGitRefs(located.root, commitId, next.remoteRef, acceptedGitCommit);
          return result(
            text(receipt),
            "zeroY repair slice pushed",
            "The exact Commit is saved. A renderable Commit has an administrator-only PreviewRelease and its Proof/Review now determine the next repair slice; only an administrator can publish a proof-ready version.",
            [
              ["Site", input.siteId],
              ["Checkout", input.checkoutId],
              ["Commit", commitId.slice(0, 19)],
            ],
          );
        }
        return yield* failure(
          "DraftRef kept advancing during automatic rebase.",
          "zeroy_checkout_rebase_limit",
        );
      }),
    ),
  );
