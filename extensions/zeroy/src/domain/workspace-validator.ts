import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { Data, Effect, FileSystem, Path, Result } from "effect";

export type WorkspaceValidationFailure = {
  readonly path: string;
  readonly contract: string;
  readonly issues: readonly string[];
};

export type WorkspaceValidation = {
  readonly failures: readonly WorkspaceValidationFailure[];
  readonly stalePaths: readonly string[];
};

export class WorkspaceValidationError extends Data.TaggedError("WorkspaceValidationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const contractPath = (relative: string): string | null => {
  if (relative === "site.json") return ".zeroy/contracts/site.schema.json";
  if (relative === "artifacts/theme/zeroy.schema.json")
    return ".zeroy/contracts/theme-schema.schema.json";
  if (relative === "artifacts/theme/zeroy.theme.json")
    return ".zeroy/contracts/theme-manifest.schema.json";
  if (relative === "artifacts/theme/zcss.design.json")
    return ".zeroy/contracts/zcss-design.schema.json";
  if (relative === "artifacts/site-logic/sitelogic.json")
    return ".zeroy/contracts/site-logic.schema.json";
  if (relative === "content/site-copy.json")
    return ".zeroy/contracts/content/site-copy.schema.json";
  const post = /^content\/posts\/([^/]+)\/[^/]+\.json$/u.exec(relative);
  if (post) return `.zeroy/contracts/content/posts/${post[1]}.schema.json`;
  const term = /^content\/terms\/([^/]+)\/[^/]+\.json$/u.exec(relative);
  if (term) return `.zeroy/contracts/content/terms/${term[1]}.schema.json`;
  const localePost = /^locales\/([^/]+)\/posts\/([^/]+)\/[^/]+\.json$/u.exec(relative);
  if (localePost)
    return `.zeroy/contracts/locales/${localePost[1]}/posts/${localePost[2]}.schema.json`;
  const localeTerm = /^locales\/([^/]+)\/terms\/([^/]+)\/[^/]+\.json$/u.exec(relative);
  if (localeTerm)
    return `.zeroy/contracts/locales/${localeTerm[1]}/terms/${localeTerm[2]}.schema.json`;
  const localeCopy = /^locales\/([^/]+)\/site-copy\.json$/u.exec(relative);
  if (localeCopy) return `.zeroy/contracts/locales/${localeCopy[1]}/site-copy.schema.json`;
  return null;
};

const issueText = (error: ErrorObject): string =>
  `${error.instancePath || "/"}: ${error.message ?? error.keyword}`;

const parseJson = (encoded: string) =>
  Effect.try({
    try: () => JSON.parse(encoded) as unknown,
    catch: (cause) => new WorkspaceValidationError({ message: "invalid JSON", cause }),
  });

const compileAndValidate = (
  ajv: InstanceType<typeof Ajv2020.default>,
  schema: object,
  value: unknown,
) =>
  Effect.try({
    try: () => {
      const validate = ajv.compile(schema);
      return validate(value) ? [] : (validate.errors ?? []).slice(0, 20).map(issueText);
    },
    catch: (cause) =>
      new WorkspaceValidationError({ message: "projected contract is invalid", cause }),
  });

/**
 * This is deliberately a generic closed-schema evaluator. Document meaning is
 * owned by the Connector-generated contracts, never reimplemented here.
 */
export const validateWorkspaceDocuments = (root: string, authoredPaths: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ajv = new Ajv2020.default({ allErrors: true, strict: false, validateFormats: false });
    const failures: WorkspaceValidationFailure[] = [];
    const stalePaths: string[] = [];
    for (const relative of authoredPaths.filter((entry) => entry.endsWith(".json"))) {
      const projected = contractPath(relative);
      if (projected === null) continue;
      const schemaFile = path.join(root, ...projected.split("/"));
      if (!(yield* fs.exists(schemaFile))) {
        stalePaths.push(relative);
        continue;
      }
      const [encoded, schemaEncoded] = yield* Effect.all([
        fs.readFileString(path.join(root, ...relative.split("/"))),
        fs.readFileString(schemaFile),
      ]);
      const decoded = yield* Effect.all([parseJson(encoded), parseJson(schemaEncoded)]).pipe(
        Effect.result,
      );
      if (Result.isFailure(decoded)) {
        failures.push({
          path: relative,
          contract: projected,
          issues: [`/: ${decoded.failure.message}`],
        });
        continue;
      }
      const [document, schema] = decoded.success;
      const checked = yield* compileAndValidate(ajv, schema as object, document).pipe(
        Effect.result,
      );
      if (
        relative === "content/site-copy.json" &&
        Result.isSuccess(checked) &&
        checked.success.length > 0 &&
        checked.success.every((issue) => issue.includes("additional properties"))
      ) {
        stalePaths.push(relative);
        continue;
      }
      if (Result.isFailure(checked) || checked.success.length > 0) {
        failures.push({
          path: relative,
          contract: projected,
          issues: Result.isFailure(checked) ? [`/: ${checked.failure.message}`] : checked.success,
        });
      }
    }
    return { failures, stalePaths };
  });
