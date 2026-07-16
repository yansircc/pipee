import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { CONNECTOR_STORAGE_KEY } from "../protocol/connector-auth.js";
import { protocolFingerprint } from "../protocol/protocol-fingerprint.js";
import {
  ConnectorIdentity as ConnectorIdentitySchema,
  ProfileConnector as ProfileConnectorSchema,
  type ConnectorIdentity,
  type ProfileConnector,
} from "../protocol/schema.js";

export class ConnectorIdentityFailure extends Data.TaggedError("ConnectorIdentityFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const readStored = Effect.tryPromise({
  try: () => chrome.storage.local.get(CONNECTOR_STORAGE_KEY),
  catch: (cause) =>
    new ConnectorIdentityFailure({ message: "Could not read profile connector identity", cause }),
});

const persist = (identity: ConnectorIdentity) =>
  Effect.tryPromise({
    try: () => chrome.storage.local.set({ [CONNECTOR_STORAGE_KEY]: identity }),
    catch: (cause) =>
      new ConnectorIdentityFailure({
        message: "Could not persist profile connector identity",
        cause,
      }),
  });

const decodeStored = (value: unknown) =>
  Schema.decodeUnknownEffect(ConnectorIdentitySchema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectorIdentityFailure({
          message: "Stored profile connector identity is invalid",
          cause,
        }),
    ),
  );

const makeIdentity = (): ConnectorIdentity => {
  const connectorId = globalThis.crypto.randomUUID();
  const secret = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    connectorId,
    secret,
    label: `Chrome ${connectorId.slice(0, 8)}`,
  };
};

const projectProfileConnector = (
  identity: ConnectorIdentity,
): Effect.Effect<ProfileConnector, ConnectorIdentityFailure> =>
  protocolFingerprint.pipe(
    Effect.mapError(
      (cause) =>
        new ConnectorIdentityFailure({
          message: "Could not compute the live connector protocol fingerprint",
          cause,
        }),
    ),
    Effect.map((fingerprint) => ({
      ...identity,
      extensionId: chrome.runtime.id,
      extensionDisplayVersion: chrome.runtime.getManifest().version,
      protocolFingerprint: fingerprint,
    })),
    Effect.flatMap(Schema.decodeUnknownEffect(ProfileConnectorSchema)),
    Effect.mapError((cause) =>
      cause instanceof ConnectorIdentityFailure
        ? cause
        : new ConnectorIdentityFailure({
            message: "Live connector metadata is invalid",
            cause,
          }),
    ),
  );

export class ConnectorIdentityOwner {
  private constructor(
    private readonly current: Ref.Ref<ConnectorIdentity | undefined>,
    private readonly lock: Semaphore.Semaphore,
  ) {}

  static makeUnsafe = (): ConnectorIdentityOwner =>
    new ConnectorIdentityOwner(
      Ref.makeUnsafe<ConnectorIdentity | undefined>(undefined),
      Semaphore.makeUnsafe(1),
    );

  private get loadUnlocked(): Effect.Effect<ProfileConnector, ConnectorIdentityFailure> {
    return Effect.gen({ self: this }, function* () {
      const current = yield* Ref.get(this.current);
      const identity =
        current ??
        (yield* Effect.gen({ self: this }, function* () {
          const record = yield* readStored;
          const stored = record[CONNECTOR_STORAGE_KEY];
          const loaded = stored === undefined ? yield* this.create : yield* decodeStored(stored);
          yield* Ref.set(this.current, loaded);
          return loaded;
        }));
      return yield* projectProfileConnector(identity);
    });
  }

  get load(): Effect.Effect<ProfileConnector, ConnectorIdentityFailure> {
    return this.lock.withPermits(1)(this.loadUnlocked);
  }

  rename(label: string): Effect.Effect<ProfileConnector, ConnectorIdentityFailure> {
    return this.lock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const normalized = label.replaceAll(/\s+/g, " ").trim().slice(0, 80);
        if (!normalized) {
          return yield* new ConnectorIdentityFailure({
            message: "Connector label cannot be empty",
          });
        }
        const connector = yield* this.loadUnlocked;
        const updated: ConnectorIdentity = {
          connectorId: connector.connectorId,
          secret: connector.secret,
          label: normalized,
        };
        yield* persist(updated);
        yield* Ref.set(this.current, updated);
        return yield* projectProfileConnector(updated);
      }),
    );
  }

  private get create(): Effect.Effect<ConnectorIdentity, ConnectorIdentityFailure> {
    const identity = makeIdentity();
    return persist(identity).pipe(Effect.as(identity));
  }
}
