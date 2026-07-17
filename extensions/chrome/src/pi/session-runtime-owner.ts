import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Authorization, AuthorizationOwner, ExpiryClaim } from "./authorization-owner.js";

export type SessionIdentity = {
  readonly key: string;
  readonly groupTitle: string;
};

export type SessionScope = {
  readonly epoch: number;
  readonly context: ExtensionContext;
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly identity: SessionIdentity;
  readonly capability: object;
};

type SessionPoison = Readonly<{ background: boolean }>;

type SessionRuntime =
  | {
      readonly _tag: "Inactive";
      readonly epoch: number;
      readonly retained: SessionScope | undefined;
    }
  | (SessionScope & { readonly _tag: "Restoring" })
  | (SessionScope & {
      readonly _tag: "Active";
      readonly authorization: AuthorizationOwner;
    })
  | (SessionScope & {
      readonly _tag: "Poisoned";
      readonly poison: SessionPoison;
    });

type SessionAuthorizationOwnerAccess =
  | { readonly _tag: "Active"; readonly authorization: AuthorizationOwner }
  | { readonly _tag: "Poisoned"; readonly background: boolean }
  | { readonly _tag: "Stale" };

type SessionAuthorizationState =
  | {
      readonly _tag: "Active";
      readonly authorized: boolean;
      readonly background: boolean;
    }
  | { readonly _tag: "Poisoned"; readonly background: boolean }
  | { readonly _tag: "Stale" };

export type SessionAuthorizationMutation =
  | {
      readonly _tag: "Authorize";
      readonly authorization: Exclude<Authorization, { readonly state: "locked" }>;
    }
  | { readonly _tag: "SetBackground"; readonly background: boolean }
  | { readonly _tag: "Lock" }
  | { readonly _tag: "Expire"; readonly claim: ExpiryClaim; readonly now: number };

type SessionAuthorizationMutationResult =
  | { readonly _tag: "Applied"; readonly changed: boolean }
  | { readonly _tag: "Poisoned"; readonly background: boolean }
  | { readonly _tag: "Stale" };

export type AuthorizedSessionClaim = Readonly<{
  scope: SessionScope;
  generation: string;
  background: boolean;
}>;

export type SessionAuthorizationSnapshot =
  | { readonly _tag: "Inactive"; readonly epoch: number }
  | { readonly _tag: "Restoring"; readonly epoch: number }
  | {
      readonly _tag: "Active";
      readonly epoch: number;
      readonly authorization: Authorization;
      readonly authorized: boolean;
      readonly background: boolean;
      readonly expiry: ExpiryClaim | undefined;
    }
  | {
      readonly _tag: "Poisoned";
      readonly epoch: number;
      readonly background: boolean;
    };

const scopeOf = (
  runtime: Exclude<SessionRuntime, { readonly _tag: "Inactive" }>,
): SessionScope => ({
  epoch: runtime.epoch,
  context: runtime.context,
  sessionManager: runtime.sessionManager,
  identity: runtime.identity,
  capability: runtime.capability,
});

export class SessionRuntimeOwner {
  private state: SessionRuntime = { _tag: "Inactive", epoch: 0, retained: undefined };
  // Pi 0.80.6 mutates its in-memory ledger before the synchronous disk append can throw.
  // These records keep that outcome-unknown write fail-closed for this process. Remove this
  // process-local state when Pi exposes a durably acknowledged or transactional append API.
  private readonly poisonedSessions = new Map<string, SessionPoison>();

  snapshot(now: number): SessionAuthorizationSnapshot {
    const state = this.state;
    if (state._tag === "Inactive" || state._tag === "Restoring") {
      return { _tag: state._tag, epoch: state.epoch };
    }
    if (state._tag === "Poisoned") {
      return { _tag: "Poisoned", epoch: state.epoch, background: state.poison.background };
    }
    return {
      _tag: "Active",
      epoch: state.epoch,
      authorization: state.authorization.current.authorization,
      authorized: state.authorization.isAuthorized(now),
      background: state.authorization.current.background,
      expiry: state.authorization.expiryClaim(),
    };
  }

  begin(): Readonly<{ epoch: number; previous: SessionScope | undefined }> {
    const previous = this.state._tag === "Inactive" ? this.state.retained : scopeOf(this.state);
    const epoch = this.state.epoch + 1;
    this.state = { _tag: "Inactive", epoch, retained: previous };
    return { epoch, previous };
  }

  admit(
    epoch: number,
    context: ExtensionContext,
    identity: SessionIdentity,
  ): Readonly<{ scope: SessionScope; retained: SessionScope | undefined }> | undefined {
    if (this.state._tag !== "Inactive" || this.state.epoch !== epoch) return undefined;
    const retained = this.state.retained;
    const scope = {
      epoch,
      context,
      sessionManager: context.sessionManager,
      identity,
      capability: {},
    } satisfies SessionScope;
    this.state = { ...scope, _tag: "Restoring" };
    return { scope, retained };
  }

  scopeFor(context: ExtensionContext, identity: SessionIdentity): SessionScope | undefined {
    if (
      (this.state._tag !== "Active" && this.state._tag !== "Poisoned") ||
      this.state.sessionManager !== context.sessionManager ||
      this.state.identity.key !== identity.key
    ) {
      return undefined;
    }
    if (this.state.identity.groupTitle !== identity.groupTitle) {
      this.state = { ...this.state, identity };
    }
    return scopeOf(this.state);
  }

  projectPoison(scope: SessionScope): boolean {
    const current = this.state;
    if (current._tag === "Inactive" || !this.matches(scope)) return false;
    const poison = this.poisonedSessions.get(scope.identity.key);
    if (!poison) return false;
    this.state = { ...scope, identity: current.identity, _tag: "Poisoned", poison };
    return true;
  }

  matches(scope: SessionScope): boolean {
    return (
      this.state._tag !== "Inactive" &&
      this.state.epoch === scope.epoch &&
      this.state.sessionManager === scope.sessionManager &&
      this.state.identity.key === scope.identity.key &&
      this.state.capability === scope.capability
    );
  }

  ensureProjected(scope: SessionScope): boolean {
    return this.matches(scope) && (this.state._tag === "Active" || this.state._tag === "Poisoned");
  }

  private authorizationOwnerAccess(scope: SessionScope): SessionAuthorizationOwnerAccess {
    if (!this.matches(scope) || this.state._tag === "Restoring" || this.state._tag === "Inactive") {
      return { _tag: "Stale" };
    }
    return this.state._tag === "Poisoned"
      ? { _tag: "Poisoned", background: this.state.poison.background }
      : { _tag: "Active", authorization: this.state.authorization };
  }

  authorizationState(scope: SessionScope, now: number): SessionAuthorizationState {
    const access = this.authorizationOwnerAccess(scope);
    return access._tag === "Active"
      ? {
          _tag: "Active",
          authorized: access.authorization.isAuthorized(now),
          background: access.authorization.current.background,
        }
      : access;
  }

  applyAuthorizationMutation(
    scope: SessionScope,
    mutation: SessionAuthorizationMutation,
  ): SessionAuthorizationMutationResult {
    const access = this.authorizationOwnerAccess(scope);
    if (access._tag !== "Active") return access;
    switch (mutation._tag) {
      case "Authorize":
        access.authorization.authorize(mutation.authorization);
        return { _tag: "Applied", changed: true };
      case "SetBackground":
        access.authorization.setBackground(mutation.background);
        return { _tag: "Applied", changed: true };
      case "Lock":
        access.authorization.lock();
        return { _tag: "Applied", changed: true };
      case "Expire":
        return {
          _tag: "Applied",
          changed: access.authorization.expireIfCurrent(mutation.claim, mutation.now),
        };
      default: {
        const exhaustive: never = mutation;
        return exhaustive;
      }
    }
  }

  claimAuthorized(scope: SessionScope, now: number): AuthorizedSessionClaim | undefined {
    const access = this.authorizationOwnerAccess(scope);
    if (access._tag !== "Active" || !access.authorization.isAuthorized(now)) return undefined;
    return {
      scope,
      generation: access.authorization.current.generation,
      background: access.authorization.current.background,
    };
  }

  validatesAuthorizedClaim(claim: AuthorizedSessionClaim, now: number): boolean {
    const access = this.authorizationOwnerAccess(claim.scope);
    return (
      access._tag === "Active" &&
      access.authorization.current.generation === claim.generation &&
      access.authorization.isAuthorized(now)
    );
  }

  publishRestored(scope: SessionScope, authorization: AuthorizationOwner): boolean {
    if (this.poisonedSessions.has(scope.identity.key)) return false;
    return this.publishActive(scope, authorization);
  }

  private publishActive(scope: SessionScope, authorization: AuthorizationOwner): boolean {
    const current = this.state;
    if (current._tag === "Inactive" || !this.matches(scope)) return false;
    this.state = { ...scope, identity: current.identity, _tag: "Active", authorization };
    return true;
  }

  poison(scope: SessionScope, background: boolean): boolean {
    const poison = { background } satisfies SessionPoison;
    this.poisonedSessions.set(scope.identity.key, poison);
    const current = this.state;
    if (current._tag === "Inactive" || !this.matches(scope)) return false;
    this.state = { ...scope, identity: current.identity, _tag: "Poisoned", poison };
    return true;
  }

  publishRepaired(scope: SessionScope, authorization: AuthorizationOwner): boolean {
    if (!this.publishActive(scope, authorization)) return false;
    this.poisonedSessions.delete(scope.identity.key);
    return true;
  }
}
