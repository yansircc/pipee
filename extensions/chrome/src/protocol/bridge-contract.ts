import bridge from "./bridge.json" with { type: "json" };

export const BRIDGE_HOST = bridge.host;
export const BRIDGE_PORT = bridge.port;
export const BRIDGE_ORIGIN = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const BRIDGE_HEADERS = bridge.headers;
export const HMAC_AUTHENTICATION = bridge.hmacAuthentication;

type RawRoute = {
  readonly method: string;
  readonly path: string;
  readonly bodyLimit: string;
  readonly responseLimit: string;
};

type TransportLimitName = keyof typeof bridge.transportLimitsBytes;
type AuthorizedRoute<Authorization extends keyof typeof bridge.routes> = {
  readonly method: string;
  readonly path: string;
  readonly bodyLimit: TransportLimitName;
  readonly responseLimit: TransportLimitName;
  readonly authorization: Authorization;
};

const authorizeRoutes = <
  Authorization extends keyof typeof bridge.routes,
  Routes extends Readonly<Record<string, RawRoute>>,
>(
  authorization: Authorization,
  routes: Routes,
) =>
  Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [name, { ...route, authorization }]),
  ) as {
    readonly [Name in keyof Routes]: AuthorizedRoute<Authorization>;
  };

const ownerRoutes = authorizeRoutes("owner", bridge.routes.owner);
const extensionRoutes = authorizeRoutes("extension", bridge.routes.extension);
const connectorRoutes = authorizeRoutes("connector", bridge.routes.connector);

type OwnerAuthorizedRouteName = keyof typeof bridge.routes.owner;
type ConnectorAuthorizedRouteName = keyof typeof bridge.routes.connector;

const mergeRouteGroups = <
  Owner extends Readonly<Record<string, AuthorizedRoute<"owner">>>,
  Extension extends Readonly<Record<string, AuthorizedRoute<"extension">>>,
  Connector extends Readonly<Record<string, AuthorizedRoute<"connector">>>,
>(
  owner: Owner,
  extension: Extension & {
    readonly [Name in Extract<keyof Extension, keyof Owner>]: never;
  },
  connector: Connector & {
    readonly [Name in Extract<keyof Connector, keyof Owner | keyof Extension>]: never;
  },
): Owner & Extension & Connector => ({ ...owner, ...extension, ...connector });

export const BRIDGE_ROUTES = mergeRouteGroups(ownerRoutes, extensionRoutes, connectorRoutes);

export const OWNER_REQUEST_DEADLINE_MS = bridge.transportDeadlinesMs.ownerRequest;
export const OWNER_COMMAND_HTTP_RESPONSE_GRACE_MS =
  bridge.transportDeadlinesMs.ownerCommandHttpResponseGrace;
export const CONNECTOR_REQUEST_DEADLINE_MS = bridge.transportDeadlinesMs.connectorRequest;
export const POLL_WAIT_DEADLINE_MS = bridge.transportDeadlinesMs.pollWait;
export const CONNECTOR_LEASE_DEADLINE_MS = bridge.transportDeadlinesMs.connectorLease;
export const INCOMING_REQUEST_DEADLINE_MS = bridge.transportDeadlinesMs.incomingRequest;
export const INCOMING_HEADERS_DEADLINE_MS = bridge.transportDeadlinesMs.incomingHeaders;
export const AUTHENTICATION_CHALLENGE_DEADLINE_MS =
  bridge.transportDeadlinesMs.authenticationChallenge;
export const AUTHENTICATION_HANDSHAKE_DEADLINE_MS =
  bridge.transportDeadlinesMs.authenticationHandshake;
export const SCREENSHOT_PAYLOAD_BYTE_LIMIT = bridge.transportLimitsBytes.screenshotPayload;
export const SCREENSHOT_LIMITS = bridge.screenshotLimits;
export const SCREENSHOT_MAX_TILE_COUNT = SCREENSHOT_LIMITS.maxTiles;
export const REQUEST_BODY_BYTE_LIMIT = bridge.transportLimitsBytes.requestBody;
export const INCOMING_CONNECTION_LIMIT = bridge.transportLimitsCount.incomingConnections;
export const PENDING_CHALLENGE_LIMIT = bridge.transportLimitsCount.pendingChallengesPerScope;
export const MAX_ADMITTED_COMMANDS_PER_CONNECTOR =
  bridge.mailboxLimits.maxAdmittedCommandsPerConnector;
export const AUTOMATION_TARGET_LIMITS = bridge.automationTargetLimits;
export const REQUEST_BODY_TOO_LARGE_STATUS = bridge.httpStatuses.requestBodyTooLarge;
export const COMMAND_DEADLINES_MS = bridge.commandDeadlinesMs;

export type BridgeRouteName = keyof typeof BRIDGE_ROUTES;
export type OwnerBridgeRouteName = OwnerAuthorizedRouteName;
export type ConnectorAuthenticatedRouteName = Exclude<
  ConnectorAuthorizedRouteName,
  "connectorHandshake"
>;

export const requestBodyLimitForRoute = (name: BridgeRouteName): number =>
  bridge.transportLimitsBytes[BRIDGE_ROUTES[name].bodyLimit];

export const responseBodyLimitForRoute = (name: BridgeRouteName): number =>
  bridge.transportLimitsBytes[BRIDGE_ROUTES[name].responseLimit];

export const isOwnerBridgeRouteName = (name: BridgeRouteName): name is OwnerBridgeRouteName =>
  BRIDGE_ROUTES[name].authorization === "owner";

export const matchesBridgeRoute = (
  name: BridgeRouteName,
  method: string | undefined,
  path: string,
): boolean => {
  const route = BRIDGE_ROUTES[name];
  return method === route.method && (route.path === "*" || path === route.path);
};

export type BridgeRouteResolution =
  | { readonly _tag: "Matched"; readonly name: BridgeRouteName }
  | { readonly _tag: "NotFound" }
  | {
      readonly _tag: "Ambiguous";
      readonly names: readonly [
        BridgeRouteName,
        BridgeRouteName,
        ...ReadonlyArray<BridgeRouteName>,
      ];
    };

export const resolveBridgeRoute = (
  method: string | undefined,
  path: string,
): BridgeRouteResolution => {
  const names = (Object.keys(BRIDGE_ROUTES) as ReadonlyArray<BridgeRouteName>).filter((name) =>
    matchesBridgeRoute(name, method, path),
  );
  if (names.length === 0) return { _tag: "NotFound" };
  if (names.length === 1) return { _tag: "Matched", name: names[0]! };
  return {
    _tag: "Ambiguous",
    names: names as [BridgeRouteName, BridgeRouteName, ...Array<BridgeRouteName>],
  };
};

export const BRIDGE_ALLOWED_METHODS = [
  ...new Set(Object.values(BRIDGE_ROUTES).map(({ method }) => method)),
].join(",");

type StatusRange = {
  readonly minimum: number;
  readonly maximum: number;
};

export type ResultDeliveryPolicy = {
  readonly acknowledgedStatus: number;
  readonly unknownCommandStatus: number;
  readonly retryableRange: StatusRange;
};

export type ResultDeliveryDecision = "terminal" | "retry" | "blocked";

export const RESULT_DELIVERY_POLICY: ResultDeliveryPolicy = bridge.resultDelivery;

const isWithin = (status: number, range: StatusRange): boolean =>
  status >= range.minimum && status <= range.maximum;

export const classifyResultDelivery = (
  status: number,
  policy: ResultDeliveryPolicy = RESULT_DELIVERY_POLICY,
): ResultDeliveryDecision => {
  if (status === policy.acknowledgedStatus || status === policy.unknownCommandStatus)
    return "terminal";
  return isWithin(status, policy.retryableRange) ? "retry" : "blocked";
};
