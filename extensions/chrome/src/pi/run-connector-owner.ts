import type { SessionWebRouteStatus, WebRunLeaseClaim } from "../protocol/schema.js";
import type { SessionScope } from "./session-runtime-owner.js";

export type RunConnectorSelection =
  | { readonly source: "terminal"; readonly expectedConnectorId: string }
  | { readonly source: "web"; readonly claim: WebRunLeaseClaim };

export type RunConnectorClaim = {
  readonly scope: SessionScope;
  readonly generation: string;
  readonly routeGeneration: string;
  readonly selection: RunConnectorSelection;
};

export type RunConnectorActivation =
  | { readonly _tag: "Activated"; readonly claim: RunConnectorClaim }
  | {
      readonly _tag: "Unavailable";
      readonly connectorId: string;
      readonly routeGeneration: string;
    }
  | { readonly _tag: "Detached" };

type RunConnectorRoute =
  | {
      readonly source: "terminal";
      readonly expectedConnectorId: string;
      readonly generation: string;
    }
  | {
      readonly source: "web";
      readonly connectorId: string;
      readonly generation: string;
      readonly claim: WebRunLeaseClaim | undefined;
    };

export type DetachedWebRoute = Readonly<{
  generation: string;
  claim: WebRunLeaseClaim | undefined;
}>;

type RunConnectorState = {
  readonly scope: SessionScope | undefined;
  readonly route: RunConnectorRoute | undefined;
  readonly prepared: WebRunLeaseClaim | undefined;
  readonly active: RunConnectorClaim | undefined;
};

const inactive = (): RunConnectorState => ({
  scope: undefined,
  route: undefined,
  prepared: undefined,
  active: undefined,
});

const sameLease = (left: WebRunLeaseClaim, right: WebRunLeaseClaim): boolean =>
  left.pairingId === right.pairingId &&
  left.leaseToken === right.leaseToken &&
  left.connectorId === right.connectorId &&
  left.sessionKey === right.sessionKey;

const selectionForRoute = (route: RunConnectorRoute): RunConnectorSelection | undefined =>
  route.source === "terminal"
    ? { source: "terminal", expectedConnectorId: route.expectedConnectorId }
    : route.claim
      ? { source: "web", claim: route.claim }
      : undefined;

export class RunConnectorOwner {
  private state = inactive();

  admit(scope: SessionScope): boolean {
    if (this.state.scope !== undefined) return false;
    this.state = { ...inactive(), scope };
    return true;
  }

  begin(): ReadonlyArray<RunConnectorSelection> {
    const selections = [
      this.state.route ? selectionForRoute(this.state.route) : undefined,
      this.state.active?.selection,
    ].filter((selection): selection is RunConnectorSelection => selection !== undefined);
    this.state = inactive();
    return selections.filter(
      (selection, index) =>
        selections.findIndex((candidate) =>
          selection.source === "terminal"
            ? candidate.source === "terminal" &&
              candidate.expectedConnectorId === selection.expectedConnectorId
            : candidate.source === "web" && sameLease(candidate.claim, selection.claim),
        ) === index,
    );
  }

  restoreWeb(scope: SessionScope, route: SessionWebRouteStatus): boolean {
    if (!this.matches(scope) || route.sessionKey !== scope.identity.key) return false;
    this.state = {
      ...this.state,
      route: {
        source: "web",
        connectorId: route.connector.connectorId,
        generation: route.generation,
        claim: route.availability === "live" ? route.claim : undefined,
      },
      prepared: undefined,
    };
    return true;
  }

  attachTerminal(scope: SessionScope, expectedConnectorId: string): boolean {
    if (!this.matches(scope)) return false;
    this.state = {
      ...this.state,
      route: {
        source: "terminal",
        expectedConnectorId,
        generation: `terminal:${expectedConnectorId}`,
      },
      prepared: undefined,
    };
    return true;
  }

  canPrepare(scope: SessionScope): boolean {
    return this.matches(scope);
  }

  prepare(
    scope: SessionScope,
    claim: WebRunLeaseClaim,
  ): ReadonlyArray<WebRunLeaseClaim> | undefined {
    if (!this.canPrepare(scope)) return undefined;
    const replaced =
      this.state.prepared && !sameLease(this.state.prepared, claim) ? [this.state.prepared] : [];
    this.state = { ...this.state, prepared: claim };
    return replaced;
  }

  assertPrepared(scope: SessionScope, pairingId: string): WebRunLeaseClaim | undefined {
    return this.matches(scope) && this.state.prepared?.pairingId === pairingId
      ? this.state.prepared
      : undefined;
  }

  commitPrepared(scope: SessionScope, pairingId: string): boolean {
    const claim = this.assertPrepared(scope, pairingId);
    if (!claim) return false;
    this.state = {
      ...this.state,
      route: {
        source: "web",
        connectorId: claim.connectorId,
        generation: claim.pairingId,
        claim,
      },
      prepared: undefined,
    };
    return true;
  }

  selectTerminal(
    scope: SessionScope,
    expectedConnectorId: string,
  ): ReadonlyArray<WebRunLeaseClaim> | undefined {
    if (!this.matches(scope)) return undefined;
    const retired = [
      this.state.prepared,
      this.state.route?.source === "web" ? this.state.route.claim : undefined,
    ].filter((claim): claim is WebRunLeaseClaim => claim !== undefined);
    this.state = {
      ...this.state,
      route: {
        source: "terminal",
        expectedConnectorId,
        generation: `terminal:${expectedConnectorId}`,
      },
      prepared: undefined,
    };
    return retired.filter(
      (claim, index) => retired.findIndex((candidate) => sameLease(candidate, claim)) === index,
    );
  }

  detach(scope: SessionScope, pairingId: string): DetachedWebRoute | undefined {
    if (!this.matches(scope)) return undefined;
    if (this.state.prepared?.pairingId === pairingId) {
      const claim = this.state.prepared;
      this.state = { ...this.state, prepared: undefined };
      return { generation: pairingId, claim };
    }
    if (this.state.route?.source !== "web" || this.state.route.generation !== pairingId) {
      return undefined;
    }
    const route = this.state.route;
    this.state = { ...this.state, route: undefined };
    return { generation: route.generation, claim: route.claim };
  }

  activate(scope: SessionScope): RunConnectorActivation {
    if (!this.matches(scope)) return { _tag: "Detached" };
    if (this.state.active) return { _tag: "Activated", claim: this.state.active };
    const route = this.state.route;
    if (!route) return { _tag: "Detached" };
    const selection = selectionForRoute(route);
    if (!selection && route.source === "web") {
      return {
        _tag: "Unavailable",
        connectorId: route.connectorId,
        routeGeneration: route.generation,
      };
    }
    if (!selection) return { _tag: "Detached" };
    const active = {
      scope,
      generation: globalThis.crypto.randomUUID(),
      routeGeneration: route.generation,
      selection,
    } satisfies RunConnectorClaim;
    this.state = { ...this.state, active };
    return { _tag: "Activated", claim: active };
  }

  settle(scope: SessionScope): boolean {
    if (!this.matches(scope) || !this.state.active) return false;
    this.state = { ...this.state, active: undefined };
    return true;
  }

  claim(scope: SessionScope): RunConnectorClaim | undefined {
    return this.matches(scope) ? this.state.active : undefined;
  }

  validates(claim: RunConnectorClaim): boolean {
    return (
      this.matches(claim.scope) &&
      this.state.active?.generation === claim.generation &&
      this.state.route?.generation === claim.routeGeneration &&
      this.state.active.selection.source === claim.selection.source &&
      (claim.selection.source === "terminal"
        ? this.state.active.selection.source === "terminal" &&
          this.state.active.selection.expectedConnectorId === claim.selection.expectedConnectorId
        : this.state.active.selection.source === "web" &&
          sameLease(this.state.active.selection.claim, claim.selection.claim))
    );
  }

  selection(scope: SessionScope): RunConnectorSelection | undefined {
    if (!this.matches(scope) || !this.state.route) return undefined;
    return selectionForRoute(this.state.route);
  }

  webRoute(scope: SessionScope): DetachedWebRoute | undefined {
    if (!this.matches(scope) || this.state.route?.source !== "web") return undefined;
    return { generation: this.state.route.generation, claim: this.state.route.claim };
  }

  private matches(scope: SessionScope): boolean {
    return this.state.scope?.capability === scope.capability;
  }
}
