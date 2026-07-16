import { Schema } from "effect"

export const ChromeProtocolRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("ProtocolCompatible"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("ProtocolCompatible"),
    satisfied: Schema.Literal(false),
    expectedVersion: Schema.String,
    actualVersion: Schema.String,
    remediation: Schema.Struct({
      type: Schema.Literal("ReloadUnpackedExtension"),
      extensionId: Schema.String,
      directory: Schema.String,
    }),
  }),
])

export const ChromeConnectorRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("ConnectorLive"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("ConnectorLive"),
    satisfied: Schema.Literal(false),
    remediation: Schema.Struct({
      type: Schema.Literal("OpenChromeProfile"),
      connectorId: Schema.optionalKey(Schema.String),
      connectorLabel: Schema.optionalKey(Schema.String),
    }),
  }),
])

export const ChromeAuthorizationRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("Authorized"), satisfied: Schema.Literal(true) }),
  Schema.Struct({
    requirement: Schema.Literal("Authorized"),
    satisfied: Schema.Literal(false),
    remediation: Schema.Struct({ type: Schema.Literal("AuthorizeSession") }),
  }),
])

export const ChromeStatusRequirement = Schema.Union([
  ChromeProtocolRequirement,
  ChromeConnectorRequirement,
  ChromeAuthorizationRequirement,
])
export type ChromeStatusRequirement = typeof ChromeStatusRequirement.Type

export const ChromeStatusProjection = Schema.Struct({
  kind: Schema.Literal("pi-chrome/status"),
  version: Schema.Literal(2),
  readiness: Schema.Literals(["ready", "offline", "locked", "error"]),
  authorization: Schema.Union([
    Schema.Literals(["indefinite", "locked"]),
    Schema.Struct({ expiresAt: Schema.Number }),
  ]),
  connection: Schema.Literals(["connected", "offline", "unavailable", "unpaired", "unknown"]),
  bridge: Schema.Literals(["running", "stopped", "error"]),
  connectorId: Schema.optionalKey(Schema.String),
  connectorLabel: Schema.optionalKey(Schema.String),
  connectorExpiresAt: Schema.optionalKey(Schema.Number),
  errorMessage: Schema.optionalKey(Schema.String),
  requirements: Schema.Array(ChromeStatusRequirement),
})
export type ChromeStatusProjection = typeof ChromeStatusProjection.Type
