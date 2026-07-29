import { Config, Data, Effect, Redacted } from "effect";

export type SiteConnection = {
  readonly siteId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly connectionKey: string;
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
    connectionKey: candidate.connectionKey.trim(),
  };
};

export const loadSiteConnections = (): Effect.Effect<
  ReadonlyArray<SiteConnection>,
  ZeroYConnectionConfigError
> =>
  Config.redacted("ZEROY_SITES").pipe(
    Effect.map((raw) => Redacted.value(raw)),
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: () => new ZeroYConnectionConfigError({ message: "ZEROY_SITES must be valid JSON." }),
      }),
    ),
    Effect.flatMap((parsed) => {
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return Effect.fail(
          new ZeroYConnectionConfigError({ message: "ZEROY_SITES must be a non-empty array." }),
        );
      }
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

export const connectionFor = (
  connections: ReadonlyArray<SiteConnection>,
  siteId: string,
): SiteConnection | ZeroYConnectionConfigError =>
  connections.find((connection) => connection.siteId === siteId) ??
  new ZeroYConnectionConfigError({ message: `Unknown zeroY siteId ${siteId}.` });
