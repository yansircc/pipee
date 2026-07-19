import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { cloneElement, type ReactElement, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { runBrowser, type Cancel } from "@/browser/api-client"

interface TooltipProps {
  readonly children: ReactElement<{ readonly "aria-describedby"?: string }>
  readonly content: ReactNode
}

export function Tooltip({ children, content }: TooltipProps) {
  const id = useId()
  const closeRef = useRef<Cancel | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useEffect(() => () => closeRef.current?.(), [])

  const open = (element: HTMLElement) => {
    closeRef.current?.()
    closeRef.current = null
    const rect = element.getBoundingClientRect()
    const halfWidth = Math.min(140, Math.max(0, (window.innerWidth - 16) / 2))
    const center = rect.left + rect.width / 2
    setPosition({
      left: Math.min(window.innerWidth - halfWidth - 8, Math.max(halfWidth + 8, center)),
      top: rect.top - 8,
    })
  }
  const close = () => {
    closeRef.current?.()
    closeRef.current = runBrowser(
      Effect.sleep("100 millis").pipe(Effect.tap(() => Effect.sync(() => setPosition(null)))),
      { onSuccess: () => undefined },
    )
  }
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ")

  return (
    <span
      aria-describedby={position === null ? undefined : id}
      {...stylex.props(styles.anchor)}
      onPointerEnter={(event) => open(event.currentTarget)}
      onPointerLeave={close}
      onFocusCapture={(event) => open(event.currentTarget)}
      onBlurCapture={close}
    >
      {cloneElement(children, { "aria-describedby": describedBy })}
      {position !== null &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            {...stylex.props(styles.tooltip)}
            style={{ left: position.left, top: position.top }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}

const styles = stylex.create({
  anchor: { display: "inline-flex" },
  tooltip: {
    backgroundColor: "var(--text)",
    border: "1px solid color-mix(in srgb, var(--text) 80%, var(--border))",
    borderRadius: 7,
    boxShadow: "0 8px 24px rgba(0,0,0,.2)",
    color: "var(--bg)",
    fontSize: 11,
    lineHeight: 1.45,
    maxWidth: 280,
    paddingBlock: 7,
    paddingInline: 9,
    pointerEvents: "none",
    position: "fixed",
    transform: "translate(-50%, -100%)",
    whiteSpace: "nowrap",
    zIndex: 1200,
  },
})
