import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import type { ActionVerb } from "./action-graph.js";
import { encodeJsonTransport } from "./json-transport.js";
import { JsonValue, type JsonValue as JsonValueType } from "./json-value.js";
import {
  AutomationStatusResult,
  CleanupAllResult,
  CleanupResult,
  ElementTarget,
  FormattedTabResult,
  InputCalls,
  PageCalls,
  PointerTarget,
  ScreenshotResultSchemas,
  SystemCalls,
  TabCalls,
  Target,
  ToolScreenshotCall,
  WaitResult,
} from "./operation-schemas.js";

export { ElementTarget, PointerTarget, Target };

const optional = Schema.optionalKey;
const description = (value: string) => ({ description: value });

export type OperationDeadlineKind = "default" | "navigate" | "wait" | "screenshot" | "text-input";

const Deadline = {
  default: "default",
  navigate: "navigate",
  wait: "wait",
  screenshot: "screenshot",
  textInput: "text-input",
} as const satisfies Readonly<Record<string, OperationDeadlineKind>>;

type ResultContract =
  | { readonly _tag: "Opaque"; readonly reason: string }
  | { readonly _tag: "Schema"; readonly schema: Schema.ConstraintDecoder<JsonValueType> }
  | {
      readonly _tag: "ScreenshotByCaptureAndFormat";
      readonly schemas: typeof ScreenshotResultSchemas;
    };

const opaque = (reason: string): ResultContract => ({ _tag: "Opaque", reason });
const result = <S extends Schema.ConstraintDecoder<JsonValueType>>(schema: S): ResultContract => ({
  _tag: "Schema",
  schema,
});
const screenshotResult: ResultContract = {
  _tag: "ScreenshotByCaptureAndFormat",
  schemas: ScreenshotResultSchemas,
};

type AtomicToolContract = {
  readonly name: `chrome_${string}`;
  readonly description: string;
  readonly promptSnippet: string;
  readonly actionVerb?: ActionVerb | undefined;
  readonly parameters?: Schema.ConstraintDecoder<unknown> | undefined;
  readonly project?:
    | ((input: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>)
    | undefined;
};

const atomicTool = (
  name: AtomicToolContract["name"],
  description: string,
  promptSnippet: string,
  options: Pick<AtomicToolContract, "actionVerb" | "parameters" | "project"> = {},
): AtomicToolContract => ({ name, description, promptSnippet, ...options });

type OperationContractsFor<
  Calls extends Readonly<Record<string, Schema.ConstraintDecoder<unknown>>>,
> = {
  readonly [Operation in keyof Calls]: {
    readonly call: Calls[Operation];
    readonly toolCall: Schema.ConstraintDecoder<unknown>;
    readonly result: ResultContract;
    readonly deadline: OperationDeadlineKind;
    readonly atomicTool?: AtomicToolContract | undefined;
  };
};

const defineOperation = <Call extends Schema.ConstraintDecoder<unknown>>(
  call: Call,
  resultContract: ResultContract,
  deadline: OperationDeadlineKind,
  atomicToolContract?: AtomicToolContract,
) => ({
  call,
  toolCall: call,
  result: resultContract,
  deadline,
  atomicTool: atomicToolContract,
});

const defineProjectedOperation = <
  WireCall extends Schema.ConstraintDecoder<unknown>,
  ToolCall extends Schema.ConstraintDecoder<unknown>,
>(
  call: WireCall,
  toolCall: ToolCall,
  resultContract: ResultContract,
  deadline: OperationDeadlineKind,
  atomicToolContract?: AtomicToolContract,
) => ({
  call,
  toolCall,
  result: resultContract,
  deadline,
  atomicTool: atomicToolContract,
});

const opaqueInput = <Operation extends keyof typeof InputCalls>(
  operation: Operation,
  atomicToolContract: AtomicToolContract,
) =>
  defineOperation(
    InputCalls[operation],
    opaque("input verification can include a page-defined snapshot"),
    Deadline.default,
    atomicToolContract,
  );

const PostActionResult = Schema.Struct({
  action: JsonValue,
  verification: Schema.Union([
    Schema.Struct({ status: Schema.Literal("not-requested") }),
    Schema.Struct({ status: Schema.Literal("observed"), snapshot: JsonValue }),
    Schema.Struct({ status: Schema.Literal("unavailable"), reason: Schema.String }),
  ]),
});

const verifiedInput = <Operation extends keyof typeof InputCalls>(
  operation: Operation,
  deadline: OperationDeadlineKind,
  atomicToolContract: AtomicToolContract,
) => defineOperation(InputCalls[operation], result(PostActionResult), deadline, atomicToolContract);

const NavigateResult = Schema.Union([
  FormattedTabResult,
  Schema.Struct({ tab: FormattedTabResult, snapshot: JsonValue }),
]);

const AtomicActionRef = Schema.String.check(Schema.isPattern(/^@?el-\d+$/)).annotate(
  description("Action ref returned by chrome_snapshot; an optional leading @ is accepted."),
);
const AtomicSelector = Schema.String.check(Schema.isPattern(/\S/));

const { kind: _clickKind, at: _clickAt, ...atomicClickFields } = InputCalls.click.fields;
const AtomicClickParameters = Schema.Union([
  Schema.Struct({ ref: AtomicActionRef, ...atomicClickFields }),
  Schema.Struct({ selector: AtomicSelector, ...atomicClickFields }),
  Schema.Struct({ x: Schema.Finite, y: Schema.Finite, ...atomicClickFields }),
]);

const { kind: _fillKind, into: _fillInto, ...atomicFillFields } = InputCalls.fill.fields;
const AtomicFillParameters = Schema.Union([
  Schema.Struct({ ref: AtomicActionRef, ...atomicFillFields }),
  Schema.Struct({ selector: AtomicSelector, ...atomicFillFields }),
]);

const { kind: _keyKind, at: _keyAt, ...atomicPressFields } = InputCalls.key.fields;
const AtomicPressParameters = Schema.Union([
  Schema.Struct({ ref: AtomicActionRef, ...atomicPressFields }),
  Schema.Struct({ selector: AtomicSelector, ...atomicPressFields }),
  Schema.Struct(atomicPressFields),
]);

const { kind: _uploadKind, into: _uploadInto, ...atomicUploadFields } = InputCalls.upload.fields;
const AtomicUploadParameters = Schema.Union([
  Schema.Struct({ ref: AtomicActionRef, ...atomicUploadFields }),
  Schema.Struct({ selector: AtomicSelector, ...atomicUploadFields }),
]);

const normalizeActionRef = (ref: unknown): unknown =>
  typeof ref === "string" && ref.startsWith("@") ? ref.slice(1) : ref;

const projectAtomicPointer = (input: Readonly<Record<string, unknown>>) => {
  const { ref, selector, x, y, ...fields } = input;
  const at =
    ref !== undefined
      ? { by: "uid", value: normalizeActionRef(ref) }
      : selector !== undefined
        ? { by: "selector", value: selector }
        : { by: "coordinate", x, y };
  return { ...fields, at };
};

const projectAtomicElement = (field: "at" | "into", input: Readonly<Record<string, unknown>>) => {
  const { ref, selector, ...fields } = input;
  const element =
    ref !== undefined
      ? { by: "uid", value: normalizeActionRef(ref) }
      : selector !== undefined
        ? { by: "selector", value: selector }
        : undefined;
  return { ...fields, ...(element === undefined ? {} : { [field]: element }) };
};

const OPERATION_CONTRACTS = {
  tab: {
    list: defineOperation(
      TabCalls.list,
      result(Schema.Array(FormattedTabResult)),
      Deadline.default,
      atomicTool(
        "chrome_tab_list",
        "List Chrome tabs visible to this Pi session.",
        "List Chrome tabs and their exact ids.",
      ),
    ),
    new: defineOperation(
      TabCalls.new,
      result(FormattedTabResult),
      Deadline.default,
      atomicTool(
        "chrome_tab_new",
        "Create another session-owned Chrome tab.",
        "Create a session-owned Chrome tab.",
      ),
    ),
    activate: defineOperation(
      TabCalls.activate,
      result(FormattedTabResult),
      Deadline.default,
      atomicTool(
        "chrome_tab_activate",
        "Activate one exact Chrome tab.",
        "Activate an exact Chrome tab.",
      ),
    ),
    close: defineOperation(
      TabCalls.close,
      result(Schema.Struct({ closed: Schema.Int })),
      Deadline.default,
      atomicTool("chrome_tab_close", "Close one exact Chrome tab.", "Close an exact Chrome tab."),
    ),
    group: defineOperation(
      TabCalls.group,
      result(FormattedTabResult),
      Deadline.default,
      atomicTool(
        "chrome_tab_group",
        "Place one exact Chrome tab in the Pi session group.",
        "Group an exact Chrome tab under the Pi session.",
      ),
    ),
    ungroup: defineOperation(
      TabCalls.ungroup,
      result(FormattedTabResult),
      Deadline.default,
      atomicTool(
        "chrome_tab_ungroup",
        "Remove one exact Chrome tab from its group.",
        "Ungroup an exact Chrome tab.",
      ),
    ),
  } satisfies OperationContractsFor<typeof TabCalls>,
  page: {
    snapshot: defineOperation(
      PageCalls.snapshot,
      opaque("snapshot payload is page-defined"),
      Deadline.default,
      atomicTool(
        "chrome_snapshot",
        "Observe the page and return a compact Action Graph. Use its refs for actions.",
        "Observe a page and obtain fresh action refs.",
      ),
    ),
    read: defineOperation(
      PageCalls.read,
      opaque("rendered page content is page-defined"),
      Deadline.default,
      atomicTool(
        "chrome_read",
        "Read bounded rendered content from the current page without loading the Action Graph.",
        "Read current rendered page content or expand a content frontier.",
      ),
    ),
    inspect: defineOperation(
      PageCalls.inspect,
      opaque("inspection payload is page-defined"),
      Deadline.default,
      atomicTool(
        "chrome_inspect",
        "Inspect one page element and its local context.",
        "Inspect one page element in detail.",
      ),
    ),
    navigate: defineOperation(
      PageCalls.navigate,
      result(NavigateResult),
      Deadline.navigate,
      atomicTool(
        "chrome_navigate",
        "Navigate the session-owned page or one explicitly selected tab.",
        "Navigate a Chrome page.",
      ),
    ),
    evaluate: defineOperation(
      PageCalls.evaluate,
      opaque("evaluation returns arbitrary page values"),
      Deadline.default,
      atomicTool(
        "chrome_evaluate",
        "Evaluate one JavaScript expression in the page and return bounded JSON.",
        "Evaluate a bounded page expression.",
      ),
    ),
    wait: defineOperation(
      PageCalls.wait,
      result(WaitResult),
      Deadline.wait,
      atomicTool("chrome_wait", "Wait for one typed page condition.", "Wait for a page condition."),
    ),
    console: defineOperation(
      PageCalls.console,
      opaque("console entries are CDP-defined"),
      Deadline.default,
      atomicTool(
        "chrome_console",
        "Read captured page console entries.",
        "Read or clear captured console entries.",
      ),
    ),
    "network-list": defineOperation(
      PageCalls["network-list"],
      opaque("network entries are CDP-defined"),
      Deadline.default,
      atomicTool(
        "chrome_network_list",
        "List captured page network requests.",
        "List or clear captured network requests.",
      ),
    ),
    "network-get": defineOperation(
      PageCalls["network-get"],
      opaque("network bodies are CDP-defined"),
      Deadline.default,
      atomicTool(
        "chrome_network_get",
        "Read one captured network request and response body.",
        "Read one captured network record.",
      ),
    ),
    screenshot: defineProjectedOperation(
      PageCalls.screenshot,
      ToolScreenshotCall,
      screenshotResult,
      Deadline.screenshot,
      atomicTool(
        "chrome_screenshot",
        "Capture the viewport or a bounded full-page tile set.",
        "Capture a Chrome screenshot.",
      ),
    ),
  } satisfies OperationContractsFor<typeof PageCalls>,
  input: {
    click: verifiedInput(
      "click",
      Deadline.default,
      atomicTool(
        "chrome_click",
        "Click a fresh Action Graph ref, selector, or viewport coordinate with real Chrome input.",
        "Click a fresh action ref with real Chrome input.",
        {
          actionVerb: "click",
          parameters: AtomicClickParameters,
          project: projectAtomicPointer,
        },
      ),
    ),
    type: verifiedInput(
      "type",
      Deadline.textInput,
      atomicTool(
        "chrome_type",
        "Type text with real Chrome keyboard input, optionally into an element.",
        "Type text with real Chrome keyboard input.",
      ),
    ),
    fill: verifiedInput(
      "fill",
      Deadline.textInput,
      atomicTool(
        "chrome_fill",
        "Replace the value of a fresh Action Graph ref or selector with real Chrome input.",
        "Fill a fresh editable action ref.",
        {
          actionVerb: "fill",
          parameters: AtomicFillParameters,
          project: (input) => projectAtomicElement("into", input),
        },
      ),
    ),
    key: verifiedInput(
      "key",
      Deadline.default,
      atomicTool(
        "chrome_press",
        "Press one key with real Chrome input, optionally after focusing a fresh Action Graph ref.",
        "Press a key, optionally on a fresh action ref.",
        {
          actionVerb: "press",
          parameters: AtomicPressParameters,
          project: (input) => projectAtomicElement("at", input),
        },
      ),
    ),
    hover: opaqueInput(
      "hover",
      atomicTool(
        "chrome_hover",
        "Move the real Chrome pointer over an element or coordinate.",
        "Hover with the real Chrome pointer.",
      ),
    ),
    drag: opaqueInput(
      "drag",
      atomicTool(
        "chrome_drag",
        "Drag between two elements or coordinates with real Chrome input.",
        "Drag with real Chrome pointer input.",
      ),
    ),
    tap: opaqueInput(
      "tap",
      atomicTool(
        "chrome_tap",
        "Send a real Chrome touch tap to an element or coordinate.",
        "Tap with real Chrome touch input.",
      ),
    ),
    scroll: opaqueInput(
      "scroll",
      atomicTool(
        "chrome_scroll",
        "Scroll the page or one element with real Chrome wheel input.",
        "Scroll with real Chrome wheel input.",
      ),
    ),
    upload: opaqueInput(
      "upload",
      atomicTool(
        "chrome_upload",
        "Upload workspace files through a fresh file-input Action Graph ref or selector.",
        "Upload workspace files through a file input.",
        {
          actionVerb: "upload",
          parameters: AtomicUploadParameters,
          project: (input) => projectAtomicElement("into", input),
        },
      ),
    ),
  } satisfies OperationContractsFor<typeof InputCalls>,
  system: {
    version: defineOperation(
      SystemCalls.version,
      result(
        Schema.Struct({
          extensionId: Schema.NonEmptyString,
          extensionDisplayVersion: Schema.NonEmptyString,
          userAgent: Schema.String,
        }),
      ),
      Deadline.default,
    ),
    "automation-status": defineOperation(
      SystemCalls["automation-status"],
      result(AutomationStatusResult),
      Deadline.default,
    ),
    cleanup: defineOperation(SystemCalls.cleanup, result(CleanupResult), Deadline.default),
    "cleanup-all": defineOperation(
      SystemCalls["cleanup-all"],
      result(CleanupAllResult),
      Deadline.default,
    ),
    probe: defineOperation(
      SystemCalls.probe,
      opaque("probe payload is page-defined"),
      Deadline.default,
    ),
  } satisfies OperationContractsFor<typeof SystemCalls>,
} as const;

export const publicToolCallContract = {
  tab: {
    operations: Object.keys(OPERATION_CONTRACTS.tab),
    example: { op: "new", url: "https://example.com" },
  },
  page: {
    operations: Object.keys(OPERATION_CONTRACTS.page),
    example: { op: "snapshot", mode: "text" },
  },
  input: {
    operations: Object.keys(OPERATION_CONTRACTS.input),
    example: { op: "click", at: { by: "uid", value: "el-1" } },
  },
} as const;

const callsOf = <
  const Field extends "call" | "toolCall",
  Contracts extends Readonly<
    Record<string, Readonly<Record<Field, Schema.ConstraintDecoder<unknown>>>>
  >,
>(
  contracts: Contracts,
  field: Field,
) =>
  Object.values(contracts).map((contract) => contract[field]) as Array<
    Contracts[keyof Contracts][Field]
  >;

type OperationStruct = Schema.Struct<Schema.Struct.Fields>;
type OperationSchema = OperationStruct | Schema.Union<ReadonlyArray<OperationStruct>>;

const operationMembers = (schema: OperationSchema): ReadonlyArray<OperationStruct> =>
  "members" in schema ? schema.members : [schema];

const atomicParameterMembers = (
  domain: "tab" | "page" | "input",
  contract: {
    readonly toolCall: Schema.ConstraintDecoder<unknown>;
    readonly atomicTool?: AtomicToolContract | undefined;
  },
): ReadonlyArray<OperationStruct> => {
  const explicit = contract.atomicTool?.parameters;
  const members = operationMembers((explicit ?? contract.toolCall) as unknown as OperationSchema);
  return members.map((member) => {
    const fields = Object.fromEntries(
      Object.entries(member.fields).filter(
        ([name]) => explicit !== undefined || name !== (domain === "tab" ? "op" : "kind"),
      ),
    ) as Schema.Struct.Fields;
    return Schema.Struct(
      domain === "page" || domain === "input"
        ? {
            target: optional(Target),
            background: optional(Schema.Boolean),
            ...fields,
          }
        : fields,
    );
  });
};

const atomicParametersFor = (
  domain: "tab" | "page" | "input",
  contract: {
    readonly toolCall: Schema.ConstraintDecoder<unknown>;
    readonly atomicTool?: AtomicToolContract | undefined;
  },
): Schema.ConstraintDecoder<unknown> => {
  const members = atomicParameterMembers(domain, contract);
  return (members.length === 1
    ? members[0]!
    : Schema.Union(
        members as [OperationStruct, OperationStruct, ...Array<OperationStruct>],
      )) as unknown as Schema.ConstraintDecoder<unknown>;
};

export type AtomicToolDescriptor = {
  readonly name: `chrome_${string}`;
  readonly label: string;
  readonly domain: "tab" | "page" | "input";
  readonly operation: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly actionVerb?: ActionVerb | undefined;
  readonly parameters: Schema.ConstraintDecoder<unknown>;
  readonly projectInput: (
    input: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>> & { readonly op: string };
};

const PUBLIC_OPERATION_DOMAINS = ["tab", "page", "input"] as const;

export const ATOMIC_TOOL_DESCRIPTORS: ReadonlyArray<AtomicToolDescriptor> =
  PUBLIC_OPERATION_DOMAINS.flatMap((domain) =>
    Object.entries(OPERATION_CONTRACTS[domain]).map(([operation, contract]) => {
      const metadata = contract.atomicTool!;
      return {
        name: metadata.name,
        label: metadata.name
          .slice("chrome_".length)
          .split("_")
          .map((part: string) => part[0]!.toUpperCase() + part.slice(1))
          .join(" "),
        domain,
        operation,
        description: metadata.description,
        promptSnippet: metadata.promptSnippet,
        actionVerb: metadata.actionVerb,
        parameters: atomicParametersFor(domain, contract),
        projectInput: (input) => ({ ...(metadata.project?.(input) ?? input), op: operation }),
      };
    }),
  );

export const ACTION_TOOL_NAME_BY_VERB = Object.fromEntries(
  ATOMIC_TOOL_DESCRIPTORS.flatMap(({ actionVerb, name }) =>
    actionVerb === undefined ? [] : [[actionVerb, name]],
  ),
) as Readonly<Record<ActionVerb, string>>;

export const atomicToolDescriptor = (name: string): AtomicToolDescriptor | undefined =>
  ATOMIC_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name);

const flatToolCallsOf = <
  Contracts extends Readonly<
    Record<string, Readonly<{ readonly toolCall: Schema.ConstraintDecoder<unknown> }>>
  >,
>(
  contracts: Contracts,
) =>
  Object.entries(contracts).flatMap(([op, contract]) =>
    operationMembers(contract.toolCall as unknown as OperationSchema).map((operation) => {
      const { kind: _kind, ...fields } = operation.fields;
      return Schema.Struct({
        op: Schema.Literal(op),
        target: optional(Target),
        background: optional(Schema.Boolean),
        ...fields,
      });
    }),
  );

const flattenToolCall = (call: {
  readonly target?: Schema.Schema.Type<typeof Target>;
  readonly background?: boolean;
  readonly operation: Readonly<Record<string, unknown>> & { readonly kind: string };
}) => {
  const { target, background, operation } = call;
  const { kind, ...fields } = operation;
  return {
    op: kind,
    ...(target === undefined ? {} : { target }),
    ...(background === undefined ? {} : { background }),
    ...fields,
  };
};

const nestToolCall = (call: Readonly<Record<string, unknown>> & { readonly op: string }) => {
  const { op, target, background, ...fields } = call;
  return {
    ...(target === undefined ? {} : { target }),
    ...(background === undefined ? {} : { background }),
    operation: { kind: op, ...fields },
  };
};

export const TabCall = Schema.Union(callsOf(OPERATION_CONTRACTS.tab, "call")).annotate(
  description(
    "Manage Chrome tabs owned by this Pi session or explicitly selected tabs. Omitted targets require an unambiguous owned set.",
  ),
);
const PageOperation = Schema.Union(callsOf(OPERATION_CONTRACTS.page, "call"));
export const PageCall = Schema.Struct({
  target: optional(Target),
  operation: PageOperation,
}).annotate(
  description("Observe, navigate, evaluate, wait for, diagnose, or capture one Chrome page."),
);
const ToolPageOperation = Schema.Union(callsOf(OPERATION_CONTRACTS.page, "toolCall"));
const NestedToolPageCall = Schema.Struct({
  target: optional(Target),
  background: optional(Schema.Boolean),
  operation: ToolPageOperation,
});
const FlatToolPageCall = Schema.Union(flatToolCallsOf(OPERATION_CONTRACTS.page));
export const ToolPageCall = FlatToolPageCall.pipe(
  Schema.decodeTo(NestedToolPageCall, {
    decode: SchemaGetter.transform(
      (call) => nestToolCall(call) as typeof NestedToolPageCall.Encoded,
    ),
    encode: SchemaGetter.transform((call) => flattenToolCall(call) as typeof FlatToolPageCall.Type),
  }),
  Schema.annotate(
    description("Observe, navigate, evaluate, wait for, diagnose, or capture one Chrome page."),
  ),
);
const InputOperation = Schema.Union(callsOf(OPERATION_CONTRACTS.input, "call"));
export const InputCall = Schema.Struct({
  target: optional(Target),
  operation: InputOperation,
}).annotate(
  description("Drive Chrome's real pointer, keyboard, touch, wheel, drag, and file-input layers."),
);
const NestedToolInputCall = Schema.Struct({
  target: optional(Target),
  background: optional(Schema.Boolean),
  operation: InputOperation,
});
const FlatToolInputCall = Schema.Union(flatToolCallsOf(OPERATION_CONTRACTS.input));
export const ToolInputCall = FlatToolInputCall.pipe(
  Schema.decodeTo(NestedToolInputCall, {
    decode: SchemaGetter.transform(
      (call) => nestToolCall(call) as typeof NestedToolInputCall.Encoded,
    ),
    encode: SchemaGetter.transform(
      (call) => flattenToolCall(call) as typeof FlatToolInputCall.Type,
    ),
  }),
  Schema.annotate(
    description(
      "Drive Chrome's real pointer, keyboard, touch, wheel, drag, and file-input layers.",
    ),
  ),
);
export const SystemCall = Schema.Union(callsOf(OPERATION_CONTRACTS.system, "call"));

export type OperationCommand =
  | { readonly domain: "tab"; readonly call: Schema.Schema.Type<typeof TabCall> }
  | { readonly domain: "page"; readonly call: Schema.Schema.Type<typeof PageCall> }
  | { readonly domain: "input"; readonly call: Schema.Schema.Type<typeof InputCall> }
  | { readonly domain: "system"; readonly call: Schema.Schema.Type<typeof SystemCall> };

export class OperationResultValidationFailure extends Data.TaggedError(
  "OperationResultValidationFailure",
)<{
  readonly domain: OperationCommand["domain"];
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

const operationNameOf = (command: OperationCommand): string => {
  switch (command.domain) {
    case "tab":
    case "system":
      return command.call.op;
    case "page":
    case "input":
      return command.call.operation.kind;
  }
};

export type OperationDeadlineProjection = {
  readonly kind: OperationDeadlineKind;
  readonly operation: unknown;
};

export const operationDeadlineProjectionFor = (
  command: OperationCommand,
): OperationDeadlineProjection => {
  const operationName = operationNameOf(command);
  const contracts = OPERATION_CONTRACTS[command.domain] as Readonly<
    Record<string, { readonly deadline: OperationDeadlineKind }>
  >;
  // The public and wire call unions are generated from this same contract map, so a decoded
  // command cannot name an operation without a descriptor.
  const deadline = contracts[operationName]!.deadline;
  const operation =
    command.domain === "page" || command.domain === "input" ? command.call.operation : command.call;
  return { kind: deadline, operation };
};

type ScreenshotOperation = Extract<
  Schema.Schema.Type<typeof PageCall>["operation"],
  { readonly kind: "screenshot" }
>;

type ScreenshotResultSchema =
  | (typeof ScreenshotResultSchemas)["viewport"]["png"]
  | (typeof ScreenshotResultSchemas)["viewport"]["jpeg"]
  | (typeof ScreenshotResultSchemas)["full-page-tiles"]["png"]
  | (typeof ScreenshotResultSchemas)["full-page-tiles"]["jpeg"];

export const screenshotResultSchemaFor = (
  operation: ScreenshotOperation,
): ScreenshotResultSchema => {
  const byFormat = ScreenshotResultSchemas[operation.capture.kind] as Readonly<
    Record<ScreenshotOperation["format"], ScreenshotResultSchema>
  >;
  return byFormat[operation.format];
};

const contractFor = (
  command: OperationCommand,
): Effect.Effect<
  { readonly operation: string; readonly result: ResultContract },
  OperationResultValidationFailure
> => {
  const operation = operationNameOf(command);
  const contracts = OPERATION_CONTRACTS[command.domain] as Readonly<
    Record<string, { readonly result: ResultContract }>
  >;
  const contract = contracts[operation];
  return contract
    ? Effect.succeed({ operation, result: contract.result })
    : Effect.fail(
        new OperationResultValidationFailure({
          domain: command.domain,
          operation,
          message: `Missing operation contract for ${command.domain}.${operation}`,
          cause: command,
        }),
      );
};

const schemaFor = (
  command: OperationCommand,
  contract: ResultContract,
): Schema.ConstraintDecoder<JsonValueType> => {
  switch (contract._tag) {
    case "Opaque":
      return JsonValue;
    case "Schema":
      return contract.schema;
    case "ScreenshotByCaptureAndFormat":
      return command.domain === "page" && command.call.operation.kind === "screenshot"
        ? screenshotResultSchemaFor(command.call.operation)
        : Schema.Never;
  }
};

export const validateOperationSuccess = (
  command: OperationCommand,
  value: unknown,
): Effect.Effect<JsonValueType, OperationResultValidationFailure> =>
  Effect.gen(function* () {
    const { operation, result: contract } = yield* contractFor(command);
    return yield* encodeJsonTransport(
      `${command.domain}.${operation} result`,
      schemaFor(command, contract),
      value,
    ).pipe(
      Effect.map(({ value }) => value),
      Effect.mapError(
        (cause) =>
          new OperationResultValidationFailure({
            domain: command.domain,
            operation,
            message: `Invalid successful result for ${command.domain}.${operation}`,
            cause,
          }),
      ),
    );
  });

const resultDocument = (contract: ResultContract): Readonly<Record<string, unknown>> => {
  switch (contract._tag) {
    case "Opaque":
      return { mode: "opaque" };
    case "Schema":
      return {
        mode: "schema",
        schema: Schema.toJsonSchemaDocument(contract.schema).schema,
      };
    case "ScreenshotByCaptureAndFormat":
      return {
        mode: "by-call-fields",
        selectors: ["call.operation.capture.kind", "call.operation.format"],
        variants: {
          viewport: {
            png: Schema.toJsonSchemaDocument(contract.schemas.viewport.png).schema,
            jpeg: Schema.toJsonSchemaDocument(contract.schemas.viewport.jpeg).schema,
          },
          "full-page-tiles": {
            png: Schema.toJsonSchemaDocument(contract.schemas["full-page-tiles"].png).schema,
            jpeg: Schema.toJsonSchemaDocument(contract.schemas["full-page-tiles"].jpeg).schema,
          },
        },
      };
  }
};

export const operationResultProtocolContract = Object.fromEntries(
  Object.entries(OPERATION_CONTRACTS).map(([domain, contracts]) => [
    domain,
    Object.fromEntries(
      Object.entries(contracts).map(([operation, contract]) => [
        operation,
        { ...resultDocument(contract.result), deadline: contract.deadline },
      ]),
    ),
  ]),
);

export type Target = Schema.Schema.Type<typeof Target>;
export type ElementTarget = Schema.Schema.Type<typeof ElementTarget>;
export type PointerTarget = Schema.Schema.Type<typeof PointerTarget>;
export type TabCall = Schema.Schema.Type<typeof TabCall>;
export type PageCall = Schema.Schema.Type<typeof PageCall>;
export type ToolPageCall = Schema.Schema.Type<typeof ToolPageCall>;
export type InputCall = Schema.Schema.Type<typeof InputCall>;
export type ToolInputCall = Schema.Schema.Type<typeof ToolInputCall>;
export type SystemCall = Schema.Schema.Type<typeof SystemCall>;
