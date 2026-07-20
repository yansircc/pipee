import { useState, useCallback, useRef } from "react"
import { inspectDrop, readDropPayload, type DropPayload } from "@/lib/drop-paths"

export type DragKind = "files" | "directory"

export function useDragDrop(onDrop: (payload: DropPayload) => void) {
  const [dragKind, setDragKind] = useState<DragKind | null>(null)
  const counterRef = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    const inspection = inspectDrop(e.dataTransfer)
    if (!inspection.hasFiles) return
    e.preventDefault()
    counterRef.current += 1
    setDragKind(inspection.hasDirectory ? "directory" : "files")
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const inspection = inspectDrop(e.dataTransfer)
    if (!inspection.hasFiles) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
    setDragKind(inspection.hasDirectory ? "directory" : "files")
  }, [])

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1
    if (counterRef.current <= 0) {
      counterRef.current = 0
      setDragKind(null)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      counterRef.current = 0
      setDragKind(null)
      onDrop(readDropPayload(e.dataTransfer))
    },
    [onDrop],
  )

  return { isDragOver: dragKind !== null, dragKind, handleDragEnter, handleDragOver, handleDragLeave, handleDrop }
}
