import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const AUTHORIZATION_ENTRY_TYPE = "pi-chrome-authorization";

const Generation = Schema.String.check(Schema.isUUID(4));
const Deadline = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const SessionAuthorizationEntry = Schema.Struct({
  version: Schema.Literal(1),
  generation: Generation,
  authorization: Schema.Union([
    Schema.Struct({ state: Schema.Literal("indefinite") }),
    Schema.Struct({ state: Schema.Literal("locked") }),
    Schema.Struct({ state: Schema.Literal("timed"), deadline: Deadline }),
  ]),
  background: Schema.Boolean,
});

export type SessionAuthorizationEntry = Schema.Schema.Type<typeof SessionAuthorizationEntry>;
export type Authorization = SessionAuthorizationEntry["authorization"];
export type ExpiryClaim = Readonly<{ generation: string; deadline: number }>;
export type AuthorizationRestoreReason = "new" | "restored" | "invalid" | "expired" | "missing";

type AppendEntry = (entry: SessionAuthorizationEntry) => void;
type MakeGeneration = () => string;

export type AuthorizationSessionLedger = Readonly<{
  getBranch: () => ReadonlyArray<SessionEntry>;
  getEntries: () => ReadonlyArray<SessionEntry>;
}>;

export type RestoreAuthorizationOwnerOptions = Readonly<{
  branch: ReadonlyArray<SessionEntry>;
  append: AppendEntry;
  now: number;
  sessionHasAuthorizationEntry?: boolean;
  makeGeneration?: MakeGeneration;
}>;

export type RestoreAuthorizationOwnerFromSessionOptions = Readonly<{
  session: AuthorizationSessionLedger;
  append: AppendEntry;
  now: number;
  makeGeneration?: MakeGeneration;
}>;

export type RepairLockedAuthorizationOwnerOptions = Readonly<{
  append: AppendEntry;
  background?: boolean;
  makeGeneration?: MakeGeneration;
}>;

const decodeEntry = Schema.decodeUnknownExit(SessionAuthorizationEntry, {
  onExcessProperty: "error",
});

const isAuthorizationEntry = (entry: SessionEntry): entry is CustomEntry<unknown> =>
  entry.type === "custom" && entry.customType === AUTHORIZATION_ENTRY_TYPE;

const hasAuthorizationEntry = (entries: ReadonlyArray<SessionEntry>): boolean =>
  entries.some(isAuthorizationEntry);

export const restoreAuthorizationOwnerFromSession = (
  options: RestoreAuthorizationOwnerFromSessionOptions,
) =>
  AuthorizationOwner.restore({
    branch: options.session.getBranch(),
    sessionHasAuthorizationEntry: hasAuthorizationEntry(options.session.getEntries()),
    append: options.append,
    now: options.now,
    ...(options.makeGeneration ? { makeGeneration: options.makeGeneration } : {}),
  });

const makeEntry = (
  generation: string,
  authorization: Authorization,
  background: boolean,
): SessionAuthorizationEntry => ({ version: 1, generation, authorization, background });

export class AuthorizationOwner {
  private constructor(
    private readonly append: AppendEntry,
    private readonly makeGeneration: MakeGeneration,
    private projection: SessionAuthorizationEntry,
  ) {}

  static restore(options: RestoreAuthorizationOwnerOptions): Readonly<{
    owner: AuthorizationOwner;
    reason: AuthorizationRestoreReason;
  }> {
    const makeGeneration = options.makeGeneration ?? (() => globalThis.crypto.randomUUID());
    let latest: CustomEntry<unknown> | undefined;
    for (let index = options.branch.length - 1; index >= 0; index -= 1) {
      const entry = options.branch[index];
      if (entry && isAuthorizationEntry(entry)) {
        latest = entry;
        break;
      }
    }

    if (!latest) {
      const missing = options.sessionHasAuthorizationEntry === true;
      const projection = makeEntry(makeGeneration(), { state: "locked" }, false);
      options.append(projection);
      return {
        owner: new AuthorizationOwner(options.append, makeGeneration, projection),
        reason: missing ? "missing" : "new",
      };
    }

    const decoded = decodeEntry(latest.data);
    if (!Exit.isSuccess(decoded)) {
      const projection = makeEntry(makeGeneration(), { state: "locked" }, false);
      options.append(projection);
      return {
        owner: new AuthorizationOwner(options.append, makeGeneration, projection),
        reason: "invalid",
      };
    }

    if (
      decoded.value.authorization.state === "timed" &&
      decoded.value.authorization.deadline <= options.now
    ) {
      const projection = makeEntry(makeGeneration(), { state: "locked" }, decoded.value.background);
      options.append(projection);
      return {
        owner: new AuthorizationOwner(options.append, makeGeneration, projection),
        reason: "expired",
      };
    }

    return {
      owner: new AuthorizationOwner(options.append, makeGeneration, decoded.value),
      reason: "restored",
    };
  }

  static repairLocked(options: RepairLockedAuthorizationOwnerOptions): AuthorizationOwner {
    const makeGeneration = options.makeGeneration ?? (() => globalThis.crypto.randomUUID());
    const projection = makeEntry(
      makeGeneration(),
      { state: "locked" },
      options.background ?? false,
    );
    options.append(projection);
    return new AuthorizationOwner(options.append, makeGeneration, projection);
  }

  get current(): SessionAuthorizationEntry {
    return this.projection;
  }

  isAuthorized(now: number): boolean {
    const authorization = this.projection.authorization;
    return (
      authorization.state === "indefinite" ||
      (authorization.state === "timed" && authorization.deadline > now)
    );
  }

  expiryClaim(): ExpiryClaim | undefined {
    const authorization = this.projection.authorization;
    return authorization.state === "timed"
      ? { generation: this.projection.generation, deadline: authorization.deadline }
      : undefined;
  }

  authorize(authorization: Exclude<Authorization, { readonly state: "locked" }>): void {
    this.persistThenProject(authorization, this.projection.background);
  }

  setBackground(background: boolean): void {
    this.persistThenProject(this.projection.authorization, background);
  }

  lock(): void {
    this.persistLockedThenProject();
  }

  expireIfCurrent(claim: ExpiryClaim, now: number): boolean {
    const authorization = this.projection.authorization;
    if (
      this.projection.generation !== claim.generation ||
      authorization.state !== "timed" ||
      authorization.deadline !== claim.deadline ||
      now < claim.deadline
    ) {
      return false;
    }
    this.persistLockedThenProject();
    return true;
  }

  private persistThenProject(authorization: Authorization, background: boolean): void {
    const next = makeEntry(this.makeGeneration(), authorization, background);
    this.append(next);
    this.projection = next;
  }

  private persistLockedThenProject(): void {
    const next = makeEntry(this.makeGeneration(), { state: "locked" }, this.projection.background);
    this.append(next);
    this.projection = next;
  }
}
