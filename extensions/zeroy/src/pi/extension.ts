import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { PresentationDocument } from "@pipee/companion-contracts/presentation";
import { withPresentation } from "@pipee/extension-kit";
import { Config, Data, Effect, Layer, ManagedRuntime, Redacted } from "effect";

const registrations = new WeakSet<object>();
const runtime = ManagedRuntime.make(Layer.empty);

type JsonRecord = Readonly<Record<string, unknown>>;

class ZeroYConnectorError extends Data.TaggedError("ZeroYConnectorError")<{
  readonly message: string;
}> {}

const InspectParameters = Type.Union([
  Type.Object({
    siteId: Type.String({ minLength: 1 }),
    resource: Type.Literal("site"),
  }),
  Type.Object({
    siteId: Type.String({ minLength: 1 }),
    resource: Type.Literal("themeFile"),
    path: Type.String({ minLength: 1 }),
  }),
]);

const ThemeApplyParameters = Type.Object({
  siteId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  content: Type.String(),
  expectedHash: Type.String({ minLength: 64, maxLength: 64 }),
});

const ContentApplyParameters = Type.Union([
  Type.Object({
    siteId: Type.String({ minLength: 1 }),
    action: Type.Literal("writeDraft"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Type.String({ minLength: 1 }),
    schemaId: Type.String({ minLength: 1 }),
    route: Type.String({ minLength: 1 }),
    document: Type.Record(Type.String(), Type.String()),
    expectedRevision: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    siteId: Type.String({ minLength: 1 }),
    action: Type.Literal("publish"),
    objectId: Type.Integer({ minimum: 1 }),
    locale: Type.String({ minLength: 1 }),
    expectedRevision: Type.Integer({ minimum: 0 }),
  }),
]);

type InspectInput = Static<typeof InspectParameters>;
type ThemeApplyInput = Static<typeof ThemeApplyParameters>;
type ContentApplyInput = Static<typeof ContentApplyParameters>;

const connectorConfig = (): Effect.Effect<
  { readonly baseUrl: string; readonly key: string },
  ZeroYConnectorError
> =>
  Config.all({
    baseUrl: Config.string("ZEROY_SITE_URL"),
    key: Config.redacted("ZEROY_CONNECTION_KEY"),
  }).pipe(
    Effect.map(({ baseUrl, key }) => ({
      baseUrl: baseUrl.trim().replace(/\/+$/, ""),
      key: Redacted.value(key).trim(),
    })),
    Effect.filterOrFail(
      ({ baseUrl, key }) => baseUrl !== "" && key !== "",
      () =>
        new ZeroYConnectorError({
          message: "Set ZEROY_SITE_URL and ZEROY_CONNECTION_KEY before using zeroY tools.",
        }),
    ),
    Effect.mapError((cause) =>
      cause instanceof ZeroYConnectorError
        ? cause
        : new ZeroYConnectorError({
            message: "Could not load zeroY Connector configuration: " + String(cause),
          }),
    ),
  );

const stringify = (value: unknown): string => JSON.stringify(value, null, 2);

const connectorErrorMessage = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("message" in value)) return undefined;
  return typeof value.message === "string" ? value.message : undefined;
};

const call = (
  path: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Effect.Effect<JsonRecord, ZeroYConnectorError> =>
  Effect.gen(function* () {
    const config = yield* connectorConfig();
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    headers.set("x-zeroy-key", config.key);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(config.baseUrl + "/wp-json/zeroy/v1/" + path, {
          ...init,
          headers,
          ...(signal === undefined ? {} : { signal }),
        }),
      catch: (cause) =>
        new ZeroYConnectorError({
          message: "zeroY Connector request failed: " + String(cause),
        }),
    });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        new ZeroYConnectorError({
          message: "zeroY Connector response could not be read: " + String(cause),
        }),
    });
    const payload = yield* Effect.try({
      try: () => JSON.parse(text) as JsonRecord,
      catch: () =>
        new ZeroYConnectorError({
          message: "zeroY Connector returned invalid JSON: " + text.slice(0, 300),
        }),
    });
    if (!response.ok) {
      const description = connectorErrorMessage(payload.error) ?? stringify(payload);
      return yield* new ZeroYConnectorError({
        message:
          "zeroY Connector rejected the request (" + String(response.status) + "): " + description,
      });
    }
    return payload;
  });

const presentation = (
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  tone: PresentationDocument["tone"] = "success",
): PresentationDocument => ({
  contract: "pipee/presentation@1",
  title,
  summary,
  tone,
  icon: "extension",
  body: {
    type: "group",
    direction: "column",
    gap: "small",
    children: fields.map(([label, value]) => ({ type: "field", label, value })),
  },
});

const toolResult = (
  text: string,
  title: string,
  summary: string,
  fields: ReadonlyArray<readonly [string, string]>,
  tone: PresentationDocument["tone"] = "success",
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: withPresentation({}, presentation(title, summary, fields, tone)),
});

const runTool = (
  effect: Effect.Effect<AgentToolResult<unknown>, ZeroYConnectorError>,
): Promise<AgentToolResult<unknown>> =>
  runtime.runPromise(
    effect.pipe(
      Effect.catch((error) =>
        Effect.succeed(
          toolResult(
            error.message,
            "zeroY Connector",
            "Request failed",
            [["Error", error.message]],
            "danger",
          ),
        ),
      ),
    ),
  );

const inspect = (
  input: InspectInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYConnectorError> => {
  const path =
    input.resource === "site" ? "site" : "theme/file?path=" + encodeURIComponent(input.path);
  return call(path, { method: "GET" }, signal).pipe(
    Effect.map((payload) =>
      toolResult(
        stringify(payload),
        "zeroY inspection",
        input.resource === "site"
          ? "Read current site and locale inventory"
          : "Read active theme file",
        [
          ["Site", input.siteId],
          ["Resource", input.resource],
        ],
      ),
    ),
  );
};

const applyTheme = (
  input: ThemeApplyInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYConnectorError> =>
  call(
    "theme/file",
    {
      method: "POST",
      body: JSON.stringify({
        path: input.path,
        content: input.content,
        expectedHash: input.expectedHash,
      }),
    },
    signal,
  ).pipe(
    Effect.map((payload) =>
      toolResult(stringify(payload), "zeroY theme updated", "Replaced one active-theme file", [
        ["Site", input.siteId],
        ["Path", input.path],
      ]),
    ),
  );

const applyContent = (
  input: ContentApplyInput,
  signal: AbortSignal | undefined,
): Effect.Effect<AgentToolResult<unknown>, ZeroYConnectorError> => {
  const path = input.action === "writeDraft" ? "locale/draft" : "locale/publish";
  const body =
    input.action === "writeDraft"
      ? {
          objectId: input.objectId,
          locale: input.locale,
          schemaId: input.schemaId,
          route: input.route,
          document: input.document,
          expectedRevision: input.expectedRevision,
        }
      : {
          objectId: input.objectId,
          locale: input.locale,
          expectedRevision: input.expectedRevision,
        };
  return call(path, { method: "POST", body: JSON.stringify(body) }, signal).pipe(
    Effect.map((payload) =>
      toolResult(
        stringify(payload),
        input.action === "writeDraft" ? "zeroY locale draft saved" : "zeroY locale published",
        input.action === "writeDraft"
          ? "Saved " + input.locale + " draft"
          : "Published " + input.locale + " locale",
        [
          ["Site", input.siteId],
          ["Object", String(input.objectId)],
          ["Locale", input.locale],
        ],
      ),
    ),
  );
};

export default function piZeroY(pi: ExtensionAPI): void {
  if (registrations.has(pi as object)) return;
  registrations.add(pi as object);

  pi.registerTool({
    name: "zeroy_inspect",
    label: "Inspect zeroY site",
    description: "Read the current zeroY site inventory or an active-theme file.",
    parameters: InspectParameters,
    execute: (_id, input, signal) => runTool(inspect(input as InspectInput, signal)),
  });

  pi.registerTool({
    name: "zeroy_theme_apply",
    label: "Update zeroY theme",
    description:
      "Replace one existing regular file inside the active WordPress theme using its exact prior SHA-256 hash.",
    parameters: ThemeApplyParameters,
    execute: (_id, input, signal) => runTool(applyTheme(input as ThemeApplyInput, signal)),
  });

  pi.registerTool({
    name: "zeroy_content_apply",
    label: "Save or publish zeroY locale content",
    description:
      "Write a locale draft or publish a complete locale draft using the exact prior locale revision.",
    parameters: ContentApplyParameters,
    execute: (_id, input, signal) => runTool(applyContent(input as ContentApplyInput, signal)),
  });
}
