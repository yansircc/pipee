import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import { AuthorizationOwner } from "../../src/pi/authorization-owner.js";
import {
  SessionRuntimeOwner,
  type SessionIdentity,
  type SessionScope,
} from "../../src/pi/session-runtime-owner.js";

const context = (name: string) =>
  ({ cwd: `/workspace/${name}`, sessionManager: {} }) as ExtensionContext;

const identity = (key: string): SessionIdentity => ({
  key: `session:${key}`,
  groupTitle: `Pi Session: ${key}`,
});

const authorization = () => {
  let generation = 0;
  return AuthorizationOwner.restore({
    branch: [],
    append: () => undefined,
    now: 0,
    makeGeneration: () =>
      `00000000-0000-4000-8000-${(++generation).toString(16).padStart(12, "0")}`,
  }).owner;
};

it("retains the last projected scope across superseding inactive epochs", () => {
  const owner = new SessionRuntimeOwner();
  const first = owner.begin();
  const active = owner.admit(first.epoch, context("first"), identity("first"))!;
  expect(owner.publishRestored(active.scope, authorization())).toBe(true);

  const superseded = owner.begin();
  const newest = owner.begin();
  expect(superseded.previous?.capability).toBe(active.scope.capability);
  expect(newest.previous?.capability).toBe(active.scope.capability);

  const replacement = owner.admit(newest.epoch, context("second"), identity("second"));
  expect(replacement?.retained?.capability).toBe(active.scope.capability);
});

it("rejects stale epochs and structurally forged scopes", () => {
  const owner = new SessionRuntimeOwner();
  const transition = owner.begin();
  const admitted = owner.admit(transition.epoch, context("owned"), identity("owned"))!;
  const forged = {
    ...admitted.scope,
    context: context("forged"),
    identity: { ...admitted.scope.identity },
    capability: {},
  } satisfies SessionScope;

  expect(owner.matches(forged)).toBe(false);
  expect(owner.publishRestored(forged, authorization())).toBe(false);
  expect(owner.publishRestored(admitted.scope, authorization())).toBe(true);
  expect(owner.scopeFor(forged.context, admitted.scope.identity)).toBeUndefined();
  const freshContext = {
    cwd: "/workspace/fresh-wrapper",
    sessionManager: admitted.scope.sessionManager,
  } as ExtensionContext;
  expect(owner.scopeFor(freshContext, admitted.scope.identity)?.capability).toBe(
    admitted.scope.capability,
  );

  owner.begin();
  expect(owner.matches(admitted.scope)).toBe(false);
  expect(owner.publishRestored(admitted.scope, authorization())).toBe(false);
});

it("exposes poisoned authorization as a state, never as a nullable owner", () => {
  const owner = new SessionRuntimeOwner();
  const transition = owner.begin();
  const admitted = owner.admit(transition.epoch, context("poisoned"), identity("poisoned"))!;

  expect(owner.poison(admitted.scope, true)).toBe(true);
  expect(owner.authorizationState(admitted.scope, 0)).toEqual({
    _tag: "Poisoned",
    background: true,
  });
  expect(owner.ensureProjected(admitted.scope)).toBe(true);

  const next = owner.begin();
  const restored = owner.admit(next.epoch, context("poisoned"), identity("poisoned"))!;
  expect(owner.publishRestored(restored.scope, authorization())).toBe(false);
  expect(owner.projectPoison(restored.scope)).toBe(true);
  expect(owner.authorizationState(restored.scope, 0)).toEqual({
    _tag: "Poisoned",
    background: true,
  });
});

it("invalidates a tool admission claim on every authorization generation change", () => {
  const owner = new SessionRuntimeOwner();
  const transition = owner.begin();
  const admitted = owner.admit(transition.epoch, context("claim"), identity("claim"))!;
  const authorizationOwner = authorization();
  authorizationOwner.authorize({ state: "indefinite" });
  expect(owner.publishRestored(admitted.scope, authorizationOwner)).toBe(true);

  const claim = owner.claimAuthorized(admitted.scope, 0)!;
  expect(owner.validatesAuthorizedClaim(claim, 0)).toBe(true);

  expect(
    owner.applyAuthorizationMutation(admitted.scope, {
      _tag: "SetBackground",
      background: true,
    }),
  ).toEqual({ _tag: "Applied", changed: true });
  expect(owner.validatesAuthorizedClaim(claim, 0)).toBe(false);
  const refreshed = owner.claimAuthorized(admitted.scope, 0)!;

  expect(owner.applyAuthorizationMutation(admitted.scope, { _tag: "Lock" })).toEqual({
    _tag: "Applied",
    changed: true,
  });
  expect(owner.validatesAuthorizedClaim(refreshed, 0)).toBe(false);
  expect(owner.claimAuthorized(admitted.scope, 0)).toBeUndefined();
});
