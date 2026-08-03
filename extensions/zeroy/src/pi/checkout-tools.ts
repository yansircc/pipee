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
  isMergeableTextPath,
  mergeJsonDocuments,
  normalizedTextBytes,
  type MergeConflict,
} from "../domain/site-merge.js";
import { verifyBrowserChallenge } from "../domain/browser-verifier.js";
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
  readonly contract: "zeroy/pending-push@1";
  readonly commandId: string;
  readonly requestHash: string;
  readonly commitHash: ObjectHash;
  readonly commit: SiteCommit;
  readonly expectedCommit: ObjectHash | null;
  readonly rootTree: ObjectHash;
  readonly mode: "checkpoint" | "release";
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
      "mode",
      "message",
      "changeSummary",
    ]) ||
    pending.contract !== "zeroy/pending-push@1" ||
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
    (pending.mode !== "checkpoint" && pending.mode !== "release") ||
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

const readOptionalFile = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* io("Could not inspect checkout file", fs.exists(file));
    return exists ? yield* io("Could not read checkout file", fs.readFile(file)) : null;
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
          parameters.set("draftRef", input.source.draftRef);
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
              : input.source.draftRef,
          observedCommit,
          expectedRefCommit: input.source === "active-release" ? null : observedCommit,
          baseReleaseId: typeof source.baseReleaseId === "string" ? source.baseReleaseId : null,
          materializedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* writeJson(descriptorPath(path, root), descriptor);
        yield* runGit(root, ["init"]);
        yield* runGit(root, ["add", "--all"]);
        yield* runGit(root, [
          "-c",
          "user.name=zeroY",
          "-c",
          "user.email=zeroy@local",
          "commit",
          "--allow-empty",
          "-m",
          "zeroY checkout baseline",
        ]);
        return result(
          text({
            checkoutId,
            path: root,
            commit: observedCommit?.slice(0, 19) ?? null,
            fileCount: files.length,
          }),
          "zeroY checkout ready",
          "Edit this local checkout, then push a checkpoint or release.",
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
              !["site.json", "artifacts", "content", "translations", "media"].includes(
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
          "Pending push envelope violates zeroy/pending-push@1.",
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
      return [{ path: relative, kind: "content" }] as readonly MergeConflict[];
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

const rebaseCheckout = (
  active: ActiveSession,
  siteId: string,
  root: string,
  descriptor: CheckoutDescriptor,
  current: ObjectHash,
  remotePaths: readonly string[],
  localPaths: readonly string[],
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    if (descriptor.observedCommit === null)
      return yield* failure(
        "Checkout has no observed commit for three-way comparison.",
        "zeroy_checkout_base_missing",
      );
    const [base, remote] = yield* Effect.all(
      [
        fetchCommitManifest(active, siteId, descriptor.observedCommit, signal),
        fetchCommitManifest(active, siteId, current, signal),
      ],
      { concurrency: 2 },
    );
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
    yield* writeJson(descriptorPath(path, root), {
      ...descriptor,
      observedCommit: current,
      expectedRefCommit: current,
      baseReleaseId: remote.baseReleaseId,
      materializedAt: DateTime.formatIso(yield* DateTime.now),
    });
    return conflicts;
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
      "Publishing a content-addressed SiteCommit outside the model context",
      [
        ["Site", input.siteId],
        ["Mode", input.mode],
      ],
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
        const scan = yield* scanCheckout(located.root);
        const changedPaths = yield* gitChangedPaths(located.root);
        yield* Effect.forEach(
          scan.paths.filter((relative) => relative.toLowerCase().endsWith(".php")),
          (relative) => runCommand(located.root, "php", ["-l", relative]),
          { concurrency: 4 },
        );
        const existingPending = yield* readPending(located.root);
        if (
          existingPending !== null &&
          (existingPending.rootTree !== scan.rootTree ||
            existingPending.mode !== input.mode ||
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
            : changedPaths.length === 0 && located.descriptor.observedCommit !== null
              ? yield* connectorGet(
                  site,
                  `site-commits/${located.descriptor.observedCommit}`,
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
                    return actual._tag === "Success" &&
                      actual.value === located.descriptor.observedCommit
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
                  parents:
                    located.descriptor.observedCommit === null
                      ? []
                      : [located.descriptor.observedCommit],
                  baseReleaseId: located.descriptor.baseReleaseId,
                  author: {
                    principal: `site:${input.siteId}`,
                    actorSessionId: active.draftActorId,
                  },
                  message: input.message ?? "",
                  createdAt: DateTime.formatIso(yield* DateTime.now),
                };
        const commitId =
          existingPending?.commitHash ??
          (changedPaths.length === 0 && located.descriptor.observedCommit !== null
            ? located.descriptor.observedCommit
            : yield* fromSiteObjectResult(commitHash(commit)));
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
            (value) => value.startsWith("content/") || value.startsWith("translations/"),
          ).length,
          uploadedObjectCount: missing.length,
          uploadedBytes,
        };
        const request = {
          checkoutId: input.checkoutId,
          refName: located.descriptor.remoteRef,
          expectedCommit: located.descriptor.expectedRefCommit,
          commitHash: commitId,
          mode: input.mode,
          message: input.message ?? "",
          changeSummary,
        };
        const requestHash =
          existingPending?.requestHash ?? (yield* fromSiteObjectResult(pushRequestHash(request)));
        const pending: PendingPush = existingPending ?? {
          contract: "zeroy/pending-push@1",
          commandId: randomUUID(),
          requestHash,
          commitHash: commitId,
          commit,
          expectedCommit: located.descriptor.expectedRefCommit,
          rootTree: scan.rootTree,
          mode: input.mode,
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
                  base: located.descriptor.observedCommit,
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
                located.descriptor,
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
                  base: located.descriptor.observedCommit,
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
              return yield* new ZeroYConnectorError({
                code: "zeroy_checkout_rebased_retry",
                message:
                  "DraftRef advanced. Remote changes were merged locally without conflicts; review git diff and retry the same push.",
                status: 409,
                data: { currentCommit: current, changedPaths: remotePaths },
              });
            });
          }),
        );
        const candidate = asRecord(receipt.candidate);
        const browserChallenge =
          candidate === null ? null : asRecord(candidate.browserVerification);
        if (
          input.mode === "release" &&
          candidate !== null &&
          typeof candidate.releaseId === "string" &&
          browserChallenge !== null
        ) {
          const browserEvidence = yield* verifyBrowserChallenge(browserChallenge as never, signal);
          receipt = yield* connectorPost(
            site,
            "site-push/finalize",
            {
              commandId: pending.commandId,
              requestHash: pending.requestHash,
              releaseId: candidate.releaseId,
              browserEvidence,
            },
            signal,
            active.draftActorId,
          );
        }
        const next: CheckoutDescriptor = {
          ...located.descriptor,
          observedCommit: commitId,
          expectedRefCommit: commitId,
          baseReleaseId:
            asRecord(receipt.release) && typeof asRecord(receipt.release)?.releaseId === "string"
              ? (asRecord(receipt.release)?.releaseId as string)
              : located.descriptor.baseReleaseId,
          materializedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* writeJson(descriptorPath(path, located.root), next);
        yield* io(
          "Could not clear pending push envelope",
          fs.remove(pendingPath(path, located.root), { force: true }),
        );
        yield* runGit(located.root, ["add", "--all"]);
        yield* runGit(located.root, [
          "-c",
          "user.name=zeroY",
          "-c",
          "user.email=zeroy@local",
          "commit",
          "--allow-empty",
          "-m",
          `zeroY ${input.mode}: ${commitId.slice(0, 19)}`,
        ]);
        return result(
          text(receipt),
          input.mode === "release" ? "zeroY release pushed" : "zeroY checkpoint pushed",
          input.mode === "release"
            ? "The exact commit is proof-bound; activation occurs only after verification passes."
            : "The DraftRef now owns this remote recovery point.",
          [
            ["Site", input.siteId],
            ["Checkout", input.checkoutId],
            ["Commit", commitId.slice(0, 19)],
          ],
        );
      }),
    ),
  );
