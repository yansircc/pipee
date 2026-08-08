import { Config, Data, Effect, Redacted } from "effect";
import type { ZeroYSiteConnectionProjection } from "@pipee/companion-contracts/zeroy-connection-registry";

/**
 * SiteConnection is the zeroY extension's read-only projection of one Pipee
 * connection. Facts live in the Pipee connection registry; this type never
 * carries grant plaintext.
 *
 * Two sources produce the projection:
 * - PersistentRegistry (production): the Pipee connection directory.
 * - EnvironmentInjected (headless/CI only): ZEROY_SITES. The legacy field
 *   connectionKey is the injected global key; production must not use it.
 */
export type SiteConnection = {
  readonly siteId: string;
  readonly label: string;
  readonly endpoint: string;
  /** Read-only projection of the grant for Connector requests (production). */
  readonly grant: {
    readonly id: string;
    readonly credentialRef: string;
  } | null;
  /** Legacy headless/CI injected global key. Never used in production. */
  readonly connectionKey: string | null;
  /** Revocation state owned by the Pipee connection registry. */
  readonly revoked: boolean;
  /** Injected by the session; resolves the grant secret from protected storage. */
  readonly readGrantSecret?: () => string;
};

export class ZeroYConnectionConfigError extends Data.TaggedError("ZeroYConnectionConfigError")<{
  readonly message: string;
}> {}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const decodeConnection = (value: unknown): SiteConnection | ZeroYConnectionConfigError => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new ZeroYConnectionConfigError({ message: "Each ZEROY_SITES item must be an object." });
  }
  const candidate = value as Record<string, unknown>;
  if (
    !nonEmptyString(candidate.siteId) ||
    !nonEmptyString(candidate.label) ||
    !nonEmptyString(candidate.endpoint) ||
    !nonEmptyString(candidate.connectionKey)
  ) {
    return new ZeroYConnectionConfigError({
      message: "Each ZEROY_SITES item requires siteId, label, endpoint and connectionKey.",
    });
  }
  const endpoint = candidate.endpoint.trim().replace(/\/+$/, "");
  if (!URL.canParse(endpoint) || !/^https?:\/\//.test(endpoint)) {
    return new ZeroYConnectionConfigError({
      message: `Invalid zeroY endpoint for ${candidate.siteId}.`,
    });
  }
  return {
    siteId: candidate.siteId.trim(),
    label: candidate.label.trim(),
    endpoint,
    grant: null,
    connectionKey: candidate.connectionKey.trim(),
    revoked: false,
  };
};
/** Load headless/CI connections from ZEROY_SITES. Empty result = no sites. */
export const loadSiteConnections = (
  name: string = "ZEROY_SITES",
): Effect.Effect<ReadonlyArray<SiteConnection>, ZeroYConnectionConfigError> =>
  Config.option(Config.redacted(name)).pipe(
    Effect.flatMap((rawOption) =>
      rawOption._tag === "None"
        ? Effect.succeed(null)
        : Effect.succeed(Redacted.value(rawOption.value)),
    ),
    Effect.flatMap((raw) =>
      raw === null || raw.trim() === ""
        ? Effect.succeed([] as ReadonlyArray<SiteConnection>)
        : Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: () =>
              new ZeroYConnectionConfigError({ message: "ZEROY_SITES must be valid JSON." }),
          }),
    ),
    Effect.flatMap((parsed) => {
      if (!Array.isArray(parsed)) {
        return Effect.fail(
          new ZeroYConnectionConfigError({ message: "ZEROY_SITES must be an array." }),
        );
      }
      if (parsed.length === 0) return Effect.succeed([] as ReadonlyArray<SiteConnection>);
      const connections: SiteConnection[] = [];
      const ids = new Set<string>();
      for (const value of parsed) {
        const connection = decodeConnection(value);
        if (connection instanceof ZeroYConnectionConfigError) return Effect.fail(connection);
        if (ids.has(connection.siteId)) {
          return Effect.fail(
            new ZeroYConnectionConfigError({
              message: `Duplicate zeroY siteId ${connection.siteId}.`,
            }),
          );
        }
        ids.add(connection.siteId);
        connections.push(connection);
      }
      return Effect.succeed(connections);
    }),
    Effect.mapError((cause) =>
      cause instanceof ZeroYConnectionConfigError
        ? cause
        : new ZeroYConnectionConfigError({
            message: `Could not load ZEROY_SITES: ${String(cause)}`,
          }),
    ),
    Effect.withSpan("zeroy.connections.load"),
  );

/** Project a registry connection into the extension's read-only SiteConnection. */
export const projectRegistryConnection = (
  projection: ZeroYSiteConnectionProjection,
  readSecret?: () => string,
): SiteConnection => {
  const base = {
    siteId: projection.siteId,
    label: projection.label,
    endpoint: projection.endpoint,
    grant: { id: projection.grantId, credentialRef: projection.credentialRef },
    connectionKey: null,
    revoked: projection.revoked,
  };
  return readSecret === undefined ? base : { ...base, readGrantSecret: readSecret };
};

export const connectionFor = (
  connections: ReadonlyArray<SiteConnection>,
  siteId: string,
): SiteConnection | ZeroYConnectionConfigError =>
  connections.find((connection) => connection.siteId === siteId) ??
  new ZeroYConnectionConfigError({ message: `Unknown zeroY siteId ${siteId}.` });
