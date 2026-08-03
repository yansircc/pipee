import { createHash } from "node:crypto";
import { Data, Effect } from "effect";

export type ObjectHash = `sha256:${string}`;

export type SiteTreeEntry = {
  readonly name: string;
  readonly kind: "blob" | "tree";
  readonly hash: ObjectHash;
  readonly mode: "file" | "executable";
};

export type SiteCommit = {
  readonly contract: "zeroy/site-commit@1";
  readonly tree: ObjectHash;
  readonly parents: readonly ObjectHash[];
  readonly baseReleaseId: string | null;
  readonly author: {
    readonly principal: string;
    readonly actorSessionId: string;
  };
  readonly message: string;
  readonly createdAt: string;
};

export class SiteObjectAlgebraError extends Data.TaggedError("SiteObjectAlgebraError")<{
  readonly code: "canonical_json_invalid" | "tree_entry_invalid" | "site_commit_invalid";
  readonly message: string;
}> {}

export type SiteObjectResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: SiteObjectAlgebraError };

const success = <A>(value: A): SiteObjectResult<A> => ({ _tag: "Success", value });
const failure = <A = never>(
  code: SiteObjectAlgebraError["code"],
  message: string,
): SiteObjectResult<A> => ({
  _tag: "Failure",
  error: new SiteObjectAlgebraError({ code, message }),
});

const mapResult = <A, B>(
  result: SiteObjectResult<A>,
  transform: (value: A) => B,
): SiteObjectResult<B> => (result._tag === "Failure" ? result : success(transform(result.value)));

const flatMapResult = <A, B>(
  result: SiteObjectResult<A>,
  transform: (value: A) => SiteObjectResult<B>,
): SiteObjectResult<B> => (result._tag === "Failure" ? result : transform(result.value));

const recordWithKeys = (
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? record
    : null;
};

const hashBytes = (bytes: Uint8Array): ObjectHash =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const domainBytes = (domain: string, bytes: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(`${domain}\0${bytes.byteLength}\0`);
  const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
  input.set(prefix);
  input.set(bytes, prefix.byteLength);
  return input;
};

const canonicalValue = (value: unknown): SiteObjectResult<unknown> => {
  if (Array.isArray(value)) {
    const values: unknown[] = [];
    for (const entry of value) {
      const canonical = canonicalValue(entry);
      if (canonical._tag === "Failure") return canonical;
      values.push(canonical.value);
    }
    return success(values);
  }
  if (value !== null && typeof value === "object") {
    const entries: Array<readonly [string, unknown]> = [];
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>).sort(
      ([left], [right]) => Buffer.from(left).compare(Buffer.from(right)),
    )) {
      const canonical = canonicalValue(entry);
      if (canonical._tag === "Failure") return canonical;
      entries.push([key, canonical.value]);
    }
    return success(Object.fromEntries(entries));
  }
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return success(value);
  }
  return failure("canonical_json_invalid", "Canonical JSON accepts only finite JSON values.");
};

export const canonicalJson = (value: unknown): SiteObjectResult<string> =>
  mapResult(canonicalValue(value), (canonical) => JSON.stringify(canonical));

export const normalizeCheckoutText = (content: string): string =>
  content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");

export const canonicalJsonDocument = (
  content: string,
): Effect.Effect<Uint8Array, SiteObjectAlgebraError> =>
  Effect.try({
    try: () => JSON.parse(normalizeCheckoutText(content)) as unknown,
    catch: () =>
      new SiteObjectAlgebraError({
        code: "canonical_json_invalid",
        message: "Checkout JSON is not valid JSON.",
      }),
  }).pipe(
    Effect.flatMap((parsed) => {
      const encoded = canonicalJson(parsed);
      return encoded._tag === "Success"
        ? Effect.succeed(new TextEncoder().encode(`${encoded.value}\n`))
        : Effect.fail(encoded.error);
    }),
  );

export const blobHash = (bytes: Uint8Array): ObjectHash => hashBytes(domainBytes("blob", bytes));

export const normalizeTreeEntries = (
  entries: readonly SiteTreeEntry[],
): SiteObjectResult<readonly SiteTreeEntry[]> => {
  const names = new Set<string>();
  const normalized: SiteTreeEntry[] = [];
  for (const entry of entries) {
    if (!checkoutSegmentIsSafe(entry.name))
      return failure("tree_entry_invalid", `Unsafe tree entry: ${entry.name}`);
    if (names.has(entry.name))
      return failure("tree_entry_invalid", `Duplicate tree entry: ${entry.name}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(entry.hash))
      return failure("tree_entry_invalid", "Invalid object hash.");
    names.add(entry.name);
    normalized.push({ ...entry });
  }
  return success(
    normalized.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name))),
  );
};

export const treeBytes = (entries: readonly SiteTreeEntry[]): SiteObjectResult<Uint8Array> =>
  flatMapResult(normalizeTreeEntries(entries), (normalized) =>
    mapResult(canonicalJson(normalized), (encoded) => new TextEncoder().encode(encoded)),
  );

export const treeHash = (entries: readonly SiteTreeEntry[]): SiteObjectResult<ObjectHash> =>
  mapResult(treeBytes(entries), (bytes) => hashBytes(domainBytes("tree", bytes)));

export const decodeSiteCommit = (value: unknown): SiteObjectResult<SiteCommit> => {
  const commit = recordWithKeys(value, [
    "contract",
    "tree",
    "parents",
    "baseReleaseId",
    "author",
    "message",
    "createdAt",
  ]);
  const author = recordWithKeys(commit?.author, ["principal", "actorSessionId"]);
  const parents = commit?.parents;
  if (
    commit?.contract !== "zeroy/site-commit@1" ||
    typeof commit.tree !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(commit.tree) ||
    !Array.isArray(parents) ||
    parents.length > 1 ||
    parents.some((parent) => typeof parent !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parent)) ||
    (commit.baseReleaseId !== null && typeof commit.baseReleaseId !== "string") ||
    author === null ||
    typeof author.principal !== "string" ||
    author.principal.length === 0 ||
    typeof author.actorSessionId !== "string" ||
    author.actorSessionId.length === 0 ||
    typeof commit.message !== "string" ||
    typeof commit.createdAt !== "string" ||
    !Number.isFinite(Date.parse(commit.createdAt))
  ) {
    return failure("site_commit_invalid", "Value violates zeroy/site-commit@1.");
  }
  return success(commit as SiteCommit);
};

export const commitBytes = (commit: SiteCommit): SiteObjectResult<Uint8Array> =>
  flatMapResult(decodeSiteCommit(commit), (decoded) =>
    mapResult(canonicalJson(decoded), (encoded) => new TextEncoder().encode(encoded)),
  );

export const commitHash = (commit: SiteCommit): SiteObjectResult<ObjectHash> =>
  mapResult(commitBytes(commit), (bytes) => hashBytes(domainBytes("commit", bytes)));

export const pushRequestHash = (request: unknown): SiteObjectResult<string> =>
  mapResult(canonicalJson(request), (encoded) =>
    hashBytes(domainBytes("push-request", new TextEncoder().encode(encoded))).slice(7),
  );

export const checkoutSegmentIsSafe = (segment: string): boolean =>
  segment.length > 0 &&
  segment !== "." &&
  segment !== ".." &&
  !segment.includes("/") &&
  !segment.includes("\\") &&
  !segment.includes("\0") &&
  Buffer.byteLength(segment) <= 255;

export const checkoutPathIsSafe = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.endsWith("/") &&
  path.split("/").every(checkoutSegmentIsSafe);
