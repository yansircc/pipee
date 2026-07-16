import { Option, Schema } from "effect"
import type { ReactNode } from "react"
import {
  ChromeStatusProjection,
  WeixinStatusProjection,
  type ExtensionStatusContribution,
  type WeixinControlRequestType,
} from "@/api/contract"
import { LoopStatusProjection, type LoopControlAction } from "@/features/session/session-automation"
import { SessionAutomationBar } from "@/components/SessionAutomationBar"

export type CompanionRendererKey = `${string}@${number}`

export interface CompanionRendererProps {
  readonly sessionId: string
  readonly sessionBusy: boolean
  readonly loopControlPending: boolean
  readonly chromeControlPending: boolean
  readonly chromeControlEnabled: boolean
  readonly weixinControlPending: boolean
  readonly onLoopControl: (action: LoopControlAction) => void
  readonly onChromeControl: (enabled: boolean) => void
  readonly onWeixinControl: (request: WeixinControlRequestType) => void
}

interface RendererDefinition {
  readonly render: (
    contribution: Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }>,
    props: CompanionRendererProps,
  ) => ReactNode
  readonly accepts: (value: unknown) => boolean
}

const panelStyle = {
  border: "1px solid var(--border)",
  borderRadius: 7,
  background: "var(--bg-panel)",
  padding: "8px 10px",
  marginBottom: 10,
} as const

const defineRenderer = <A, I>(
  schema: Schema.Codec<A, I>,
  render: (value: A, props: CompanionRendererProps) => ReactNode,
): RendererDefinition => {
  const decode = Schema.decodeUnknownOption(schema)
  return {
    accepts: (value) => Option.isSome(decode(value)),
    render: (contribution, props) =>
      Option.match(decode(contribution.value), {
        onNone: () => <IncompatibleRenderer contribution={contribution} />,
        onSome: (value) => render(value, props),
      }),
  }
}

const renderers = {
  "pi-loop/status@1": defineRenderer(LoopStatusProjection, (status, props) =>
    status.sessionId === props.sessionId ? (
      <SessionAutomationBar
        status={status}
        pending={props.loopControlPending}
        sessionBusy={props.sessionBusy}
        onControl={props.onLoopControl}
      />
    ) : null,
  ),
  "pi-weixin/status@2": defineRenderer(WeixinStatusProjection, (status, props) => {
    const binding = status.bindings.find((item) => item.sessionId === props.sessionId)
    return (
      <div style={panelStyle} data-companion-renderer="pi-weixin/status@2">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span>Weixin · {binding?.phase ?? "Not bound"}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              disabled={props.weixinControlPending}
              onClick={() => props.onWeixinControl({ action: { _tag: binding === undefined ? "Login" : "Status" } })}
            >
              {binding === undefined ? "Login" : "Refresh"}
            </button>
            {binding !== undefined && (
              <button
                type="button"
                disabled={props.weixinControlPending}
                onClick={() => props.onWeixinControl({ action: { _tag: binding.connected ? "Stop" : "Start" } })}
              >
                {binding.connected ? "Stop" : "Start"}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }),
  "pi-chrome/status@2": defineRenderer(ChromeStatusProjection, (status, props) => (
    <div style={panelStyle} data-companion-renderer="pi-chrome/status@2">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>Chrome · {status.readiness}</span>
        <button
          type="button"
          disabled={props.chromeControlPending}
          onClick={() => props.onChromeControl(!props.chromeControlEnabled)}
        >
          {props.chromeControlEnabled ? "Disable" : "Enable"}
        </button>
      </div>
    </div>
  )),
} satisfies Record<CompanionRendererKey, RendererDefinition>

export const companionRendererKeys = Object.keys(renderers) as ReadonlyArray<keyof typeof renderers>

const rendererFor = (key: CompanionRendererKey): RendererDefinition | undefined =>
  Object.prototype.hasOwnProperty.call(renderers, key) ? renderers[key as keyof typeof renderers] : undefined

export const inspectCompanionContribution = (
  contribution: Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }>,
): "known" | "incompatible" | "unknown" => {
  const renderer = rendererFor(`${contribution.kind}@${contribution.version}`)
  if (renderer === undefined) return "unknown"
  return renderer.accepts(contribution.value) ? "known" : "incompatible"
}

function IncompatibleRenderer({
  contribution,
}: {
  readonly contribution: Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }>
}) {
  return (
    <details style={panelStyle} data-companion-renderer="incompatible">
      <summary>
        {contribution.kind}@{contribution.version} · incompatible
      </summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(contribution.value, null, 2)}
      </pre>
    </details>
  )
}

function UnknownRenderer({
  contribution,
}: {
  readonly contribution: Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }>
}) {
  return (
    <details style={panelStyle} data-companion-renderer="unknown">
      <summary>
        {contribution.kind}@{contribution.version}
      </summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify(contribution.value, null, 2)}
      </pre>
    </details>
  )
}

export function CompanionRendererRegistry({
  statuses,
  ...props
}: CompanionRendererProps & { readonly statuses: ReadonlyArray<ExtensionStatusContribution> }) {
  return statuses
    .filter(
      (status): status is Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }> =>
        status._tag === "Structured",
    )
    .map((status) => {
      const renderer = rendererFor(`${status.kind}@${status.version}`)
      return (
        <div key={status.key}>
          {renderer === undefined ? <UnknownRenderer contribution={status} /> : renderer.render(status, props)}
        </div>
      )
    })
}
