import * as stylex from "@stylexjs/stylex"
import type { CSSProperties, ReactNode } from "react"
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components"

interface SettingsWorkspaceProps {
  readonly actions?: ReactNode
  readonly children: ReactNode
  readonly closeLabel: string
  readonly context?: ReactNode
  readonly height: CSSProperties["height"]
  readonly leading?: ReactNode
  readonly onClose: () => void
  readonly title: string
  readonly width: CSSProperties["width"]
}

export function SettingsWorkspace({
  actions,
  children,
  closeLabel,
  context,
  height,
  leading,
  onClose,
  title,
  width,
}: SettingsWorkspaceProps) {
  return (
    <ModalOverlay
      isDismissable
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      {...stylex.props(styles.overlay)}
    >
      <Modal {...stylex.props(styles.modal)} style={{ height, width }}>
        <Dialog aria-label={title} {...stylex.props(styles.dialog)}>
          <header {...stylex.props(styles.header)}>
            {leading}
            <div {...stylex.props(styles.identity)}>
              <span {...stylex.props(styles.title)}>{title}</span>
              {context}
            </div>
            {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
            <Button aria-label={closeLabel} onPress={onClose} {...stylex.props(styles.close)}>
              ×
            </Button>
          </header>
          <div {...stylex.props(styles.content)}>{children}</div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  )
}

const styles = stylex.create({
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.35)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    position: "fixed",
    zIndex: "var(--layer-modal)",
  },
  modal: {
    backgroundColor: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: { default: 10, "@media (max-width: 760px)": 0 },
    boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
    maxHeight: { default: "calc(100dvh - 16px)", "@media (max-width: 760px)": "100dvh" },
    maxWidth: { default: "calc(100vw - 16px)", "@media (max-width: 760px)": "100vw" },
    overflow: "hidden",
  },
  dialog: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    outline: "none",
  },
  header: {
    alignItems: "center",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexShrink: 0,
    gap: 12,
    padding: "12px 18px",
  },
  identity: {
    alignItems: "baseline",
    display: "flex",
    gap: 10,
    minWidth: 0,
  },
  title: {
    color: "var(--text)",
    fontSize: 15,
    fontWeight: 700,
  },
  actions: {
    alignItems: "center",
    display: "flex",
    flex: 1,
    gap: 6,
    justifyContent: "flex-end",
    minWidth: 0,
  },
  close: {
    backgroundColor: {
      default: "transparent",
      ":hover": "var(--bg-hover)",
    },
    border: "none",
    borderRadius: 5,
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: 20,
    lineHeight: 1,
    outline: "none",
    padding: "2px 6px",
    ":focus-visible": {
      boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 42%, transparent)",
    },
  },
  content: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
})
