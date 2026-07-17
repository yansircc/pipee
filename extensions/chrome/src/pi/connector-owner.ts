import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { CommandBroker } from "../core/broker.js";
import { ConnectorAlreadyBound, ConnectorNotBound } from "../core/errors.js";
import type { ProfileConnector } from "../protocol/schema.js";

export class ConnectorOwner {
  private constructor(
    private readonly currentRef: Ref.Ref<ProfileConnector | undefined>,
    private readonly broker: CommandBroker,
    private readonly transitionLock: Semaphore.Semaphore,
  ) {}

  static make = (broker: CommandBroker) =>
    Effect.all({
      currentRef: Ref.make<ProfileConnector | undefined>(undefined),
      transitionLock: Semaphore.make(1),
    }).pipe(
      Effect.map(
        ({ currentRef, transitionLock }) => new ConnectorOwner(currentRef, broker, transitionLock),
      ),
    );

  get current(): Effect.Effect<ProfileConnector | undefined> {
    return Ref.get(this.currentRef);
  }

  get requireConnector(): Effect.Effect<ProfileConnector, ConnectorNotBound> {
    return this.current.pipe(
      Effect.flatMap((connector) =>
        connector
          ? Effect.succeed(connector)
          : Effect.fail(
              new ConnectorNotBound({
                message:
                  "Chrome extension is not connected. Load the unpacked extension and retry.",
              }),
            ),
      ),
    );
  }

  adopt(connector: ProfileConnector): Effect.Effect<void, ConnectorAlreadyBound> {
    return this.transitionLock.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        const current = yield* Ref.get(this.currentRef);
        if (current && current.connectorId !== connector.connectorId) {
          const status = yield* this.broker.status(current.connectorId);
          if (status.connected) {
            return yield* new ConnectorAlreadyBound({
              actualConnectorId: current.connectorId,
              message: `Chrome connector ${current.connectorId.slice(0, 8)} is already active`,
            });
          }
        }
        if (current?.connectorId !== connector.connectorId) {
          yield* this.broker.register(connector.connectorId);
        }
        yield* Ref.set(this.currentRef, connector);
        if (current && current.connectorId !== connector.connectorId) {
          yield* this.broker.drop(current.connectorId);
        }
      }),
    );
  }

  authorizedConnector(connectorId: string): Effect.Effect<ProfileConnector | undefined> {
    return this.current.pipe(
      Effect.map((connector) => (connector?.connectorId === connectorId ? connector : undefined)),
    );
  }
}
