import type { LivePresentationItem } from "@/api/contract"
import { PresentationSurface } from "@/components/PresentationSurface"

export function LivePresentationRegion({
  presentations,
}: {
  readonly presentations: ReadonlyArray<LivePresentationItem>
}) {
  if (presentations.length === 0) return null
  return (
    <div className="presentation-status-rail" aria-label="Extension status">
      {presentations.map((presentation) => (
        <div key={presentation.key} className="presentation-status-slot" data-presentation-key={presentation.key}>
          <PresentationSurface mode="live" document={presentation.document} />
        </div>
      ))}
    </div>
  )
}
