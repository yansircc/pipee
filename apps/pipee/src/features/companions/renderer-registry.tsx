import type { ExtensionStatusContribution } from "@/api/contract"
import { CompanionViewSurface } from "@/components/ExtensionSurface"
import { companionViewFromValue } from "@/lib/companion-view"

export interface CompanionRendererProps {
  readonly sessionId: string
}

type StructuredContribution = Extract<ExtensionStatusContribution, { readonly _tag: "Structured" }>

export const inspectCompanionContribution = (
  contribution: StructuredContribution,
): "known" | "incompatible" | "unknown" => {
  const projection = companionViewFromValue(contribution.value)
  if (projection === null) return "unknown"
  return projection._tag === "Valid" ? "known" : "incompatible"
}

function RawCompanionFallback({
  contribution,
  reason,
}: {
  readonly contribution: StructuredContribution
  readonly reason: "incompatible" | "unknown"
}) {
  return (
    <details className="extension-status-fallback" data-companion-renderer={reason}>
      <summary>
        {contribution.kind}@{contribution.version} · {reason}
      </summary>
      <pre>{JSON.stringify(contribution.value, null, 2)}</pre>
    </details>
  )
}

export function CompanionRendererRegistry({
  statuses,
}: CompanionRendererProps & {
  readonly statuses: ReadonlyArray<ExtensionStatusContribution>
}) {
  const items = statuses
    .filter((status): status is StructuredContribution => status._tag === "Structured")
    .map((status) => {
      const projection = companionViewFromValue(status.value)
      return (
        <div key={status.key} className="companion-status-slot">
          {projection === null ? (
            <RawCompanionFallback contribution={status} reason="unknown" />
          ) : projection._tag === "Invalid" ? (
            <RawCompanionFallback contribution={status} reason="incompatible" />
          ) : (
            <CompanionViewSurface renderer={projection.view.contract} view={projection.view} />
          )}
        </div>
      )
    })
  return items.length > 0 ? <div className="companion-status-grid">{items}</div> : null
}
