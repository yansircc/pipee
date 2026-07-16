import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  OperationResultValidationFailure,
  validateOperationSuccess,
  type OperationCommand,
} from "../../src/protocol/operation-contract.js";

const tab = {
  id: 7,
  windowId: 3,
  active: true,
  highlighted: true,
  title: "Operation contract fixture",
  url: "https://example.test/operation-contract",
  groupId: -1,
  group: null,
} as const;

const dataUrl = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
const viewportResult = { kind: "image", format: "png", dataUrl, tab } as const;
const fullPageResult = {
  kind: "tile-set",
  format: "png",
  tab,
  dimensions: { width: 10, height: 20, viewportHeight: 10, dpr: 1 },
  tiles: [
    { y: 0, dataUrl },
    { y: 10, dataUrl },
  ],
} as const;

const viewportCommand = {
  domain: "page",
  call: {
    operation: { kind: "screenshot", format: "png", capture: { kind: "viewport" } },
  },
} satisfies OperationCommand;

const fullPageCommand = {
  domain: "page",
  call: {
    operation: {
      kind: "screenshot",
      format: "png",
      capture: { kind: "full-page-tiles" },
    },
  },
} satisfies OperationCommand;

it.effect("selects the screenshot result schema from the originating call", () =>
  Effect.gen(function* () {
    expect(yield* validateOperationSuccess(viewportCommand, viewportResult)).toEqual(
      viewportResult,
    );
    expect(yield* validateOperationSuccess(fullPageCommand, fullPageResult)).toEqual(
      fullPageResult,
    );
    expect(
      yield* validateOperationSuccess(viewportCommand, fullPageResult).pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
    expect(
      yield* validateOperationSuccess(fullPageCommand, viewportResult).pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
  }),
);

it.effect("rejects incomplete or format-inconsistent screenshot tile sets", () =>
  Effect.gen(function* () {
    const jpegDataUrl = `data:image/jpeg;base64,${Buffer.from("image").toString("base64")}`;
    const invalidResults = [
      { ...fullPageResult, tiles: [{ y: 0, dataUrl }] },
      {
        ...fullPageResult,
        tiles: [
          { y: 0, dataUrl },
          { y: 0, dataUrl },
        ],
      },
      {
        ...fullPageResult,
        tiles: [
          { y: 10, dataUrl },
          { y: 0, dataUrl },
        ],
      },
      {
        ...fullPageResult,
        tiles: [
          { y: 0, dataUrl },
          { y: 10, dataUrl: jpegDataUrl },
        ],
      },
      { ...fullPageResult, format: "jpeg" },
    ] as const;

    for (const invalid of invalidResults) {
      expect((yield* Effect.exit(validateOperationSuccess(fullPageCommand, invalid)))._tag).toBe(
        "Failure",
      );
    }
  }),
);

it.effect("validates precise tab and system results", () =>
  Effect.gen(function* () {
    const tabList = {
      domain: "tab",
      call: { op: "list" },
    } satisfies OperationCommand;
    const version = {
      domain: "system",
      call: { op: "version" },
    } satisfies OperationCommand;

    expect(yield* validateOperationSuccess(tabList, [])).toEqual([]);
    expect(yield* validateOperationSuccess(tabList, "not-a-list").pipe(Effect.flip)).toMatchObject({
      _tag: "OperationResultValidationFailure",
      domain: "tab",
      operation: "list",
    });
    expect(
      yield* validateOperationSuccess(version, { extensionId: "missing-fields" }).pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
    expect(
      yield* validateOperationSuccess(version, {
        extensionId: "extension-package",
        extensionDisplayVersion: "1.0.0",
        userAgent: "operation-contract-test",
      }),
    ).toMatchObject({ extensionId: "extension-package" });
  }),
);

it.effect("preserves arbitrary page-defined values only for explicit opaque operations", () =>
  Effect.gen(function* () {
    const evaluate = {
      domain: "page",
      call: {
        operation: { kind: "evaluate", expression: "globalThis.__arbitraryValue" },
      },
    } satisfies OperationCommand;
    const arbitrary = { nested: [1, "two", null], record: { accepted: true } };

    expect(yield* validateOperationSuccess(evaluate, arbitrary)).toEqual(arbitrary);
  }),
);

it.effect("validates the post-action verification algebra instead of an opaque input result", () =>
  Effect.gen(function* () {
    const click = {
      domain: "input",
      call: {
        operation: {
          kind: "click",
          at: { by: "uid", value: "el-1" },
          includeSnapshot: true,
        },
      },
    } satisfies OperationCommand;
    const observed = {
      action: { input: "chrome", outcome: "effect-observed" },
      verification: { status: "observed", snapshot: { mode: "auto", actions: [] } },
    } as const;
    const unavailable = {
      action: { input: "chrome", outcome: "effect-observed" },
      verification: { status: "unavailable", reason: "page changed during snapshot" },
    } as const;

    expect(yield* validateOperationSuccess(click, observed)).toEqual(observed);
    expect(yield* validateOperationSuccess(click, unavailable)).toEqual(unavailable);
    expect(
      yield* validateOperationSuccess(click, {
        result: observed.action,
        snapshot: observed.verification.snapshot,
      }).pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
  }),
);

it.effect("validates typed wait observations and composed navigation snapshots", () =>
  Effect.gen(function* () {
    const wait = {
      domain: "page",
      call: {
        operation: {
          kind: "wait",
          condition: { by: "selector", value: "article" },
        },
      },
    } satisfies OperationCommand;
    const navigate = {
      domain: "page",
      call: {
        operation: {
          kind: "navigate",
          url: "https://example.test/",
          snapshot: { mode: "text" },
        },
      },
    } satisfies OperationCommand;
    const waitResult = {
      satisfied: false,
      elapsedMs: 10_000,
      observation: {
        url: "https://example.test/",
        title: "Example",
        readyState: "complete",
        bodyTextLength: 120,
        matchCount: 0,
      },
    } as const;
    const navigationResult = {
      tab,
      snapshot: {
        title: "Example",
        url: "https://example.test/",
        mode: "text",
        contentBlocks: [],
      },
    } as const;

    expect(yield* validateOperationSuccess(wait, waitResult)).toEqual(waitResult);
    expect(
      yield* validateOperationSuccess(wait, { elapsedMs: 10_000 }).pipe(Effect.flip),
    ).toBeInstanceOf(OperationResultValidationFailure);
    expect(yield* validateOperationSuccess(navigate, navigationResult)).toEqual(navigationResult);
    expect(yield* validateOperationSuccess(navigate, tab)).toEqual(tab);
  }),
);
