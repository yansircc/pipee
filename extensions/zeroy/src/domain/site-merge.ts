import { normalizeCheckoutText } from "./site-objects.js";

export type MergeConflict = {
  readonly path: string;
  readonly fieldPath?: string;
  readonly kind: "content" | "delete-modify" | "binary";
};

export type JsonMergeResult = {
  readonly value: unknown;
  readonly conflicts: readonly string[];
};

const missing = Symbol("zeroy.merge.missing");
type Value =
  | string
  | number
  | boolean
  | null
  | readonly unknown[]
  | Record<string, unknown>
  | typeof missing;

const isRecord = (value: Value): value is Record<string, unknown> =>
  value !== missing && typeof value === "object" && value !== null && !Array.isArray(value);

const equal = (left: Value, right: Value): boolean => {
  if (left === missing || right === missing) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
};

const pointerSegment = (value: string): string => value.replaceAll("~", "~0").replaceAll("/", "~1");

const mergeJsonValue = (
  base: Value,
  ours: Value,
  remote: Value,
  pointer: string,
): { readonly value: Value; readonly conflicts: readonly string[] } => {
  if (equal(ours, remote)) return { value: ours, conflicts: [] };
  if (equal(ours, base)) return { value: remote, conflicts: [] };
  if (equal(remote, base)) return { value: ours, conflicts: [] };
  if (isRecord(base) && isRecord(ours) && isRecord(remote)) {
    const keys = [
      ...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(remote)]),
    ].sort();
    const output: Record<string, unknown> = {};
    const conflicts: string[] = [];
    for (const key of keys) {
      const child = mergeJsonValue(
        Object.hasOwn(base, key) ? (base[key] as Value) : missing,
        Object.hasOwn(ours, key) ? (ours[key] as Value) : missing,
        Object.hasOwn(remote, key) ? (remote[key] as Value) : missing,
        `${pointer}/${pointerSegment(key)}`,
      );
      conflicts.push(...child.conflicts);
      if (child.value !== missing) output[key] = child.value;
    }
    return { value: output, conflicts };
  }
  return { value: ours, conflicts: [pointer || "/"] };
};

export const mergeJsonDocuments = (
  base: unknown,
  ours: unknown,
  remote: unknown,
): JsonMergeResult => {
  const merged = mergeJsonValue(base as Value, ours as Value, remote as Value, "");
  return {
    value: merged.value === missing ? null : merged.value,
    conflicts: merged.conflicts,
  };
};

export const decodeJsonDocument = (bytes: Uint8Array): unknown =>
  JSON.parse(new TextDecoder().decode(bytes)) as unknown;

export const encodeJsonDocument = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

export const isMergeableTextPath = (path: string): boolean =>
  [".php", ".css", ".js", ".mjs", ".cjs", ".html", ".md", ".txt", ".svg"].some((extension) =>
    path.toLowerCase().endsWith(extension),
  );

export const normalizedTextBytes = (value: string): Uint8Array =>
  new TextEncoder().encode(normalizeCheckoutText(value));
