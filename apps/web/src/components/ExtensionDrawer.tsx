import * as stylex from "@stylexjs/stylex"
import { PluginsConfig } from "@/browser/code-split"
import type { WeixinStatusProjection } from "@/api/contract"
import type { ChromeExtensionHealth } from "@/lib/chrome-extension-installation"
import { useI18n } from "@/lib/i18n"

type ExtensionDrawerProps = {
  readonly chromeHealth: ChromeExtensionHealth | null
  readonly initialPackageName?: string
  readonly onClose: () => void
  readonly onOpenPackage: (packageName: string) => void
  readonly onReloaded: () => void
  readonly openablePackageNames: ReadonlySet<string>
  readonly projectCwds: readonly string[]
  readonly weixinStatus: WeixinStatusProjection | undefined
}

export function ExtensionDrawer({
  chromeHealth,
  initialPackageName,
  onClose,
  onOpenPackage,
  onReloaded,
  openablePackageNames,
  projectCwds,
  weixinStatus,
}: ExtensionDrawerProps) {
  const { t } = useI18n()

  return (
    <div {...stylex.props(styles.backdrop)} onMouseDown={onClose}>
      <section
        className={`${stylex.props(styles.drawer).className} extension-drawer`}
        role="dialog"
        aria-modal="true"
        aria-label={t("Plugins")}
        tabIndex={-1}
        autoFocus
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button type="button" onClick={onClose} aria-label={t("Close")} {...stylex.props(styles.close)}>
          ×
        </button>
        <PluginsConfig
          presentation="page"
          cwd={null}
          sessionId={null}
          projectCwds={projectCwds}
          initialPackageName={initialPackageName}
          chromeHealth={chromeHealth}
          weixinStatus={weixinStatus}
          onClose={onClose}
          openablePackageNames={openablePackageNames}
          onOpenPackage={onOpenPackage}
          onReloaded={onReloaded}
        />
      </section>
    </div>
  )
}

const styles = stylex.create({
  backdrop: {
    alignItems: "stretch",
    backdropFilter: "blur(2px)",
    backgroundColor: "rgba(20, 21, 18, 0.36)",
    display: "flex",
    inset: 0,
    justifyContent: "flex-end",
    position: "fixed",
    zIndex: "var(--layer-drawer)",
  },
  drawer: {
    backgroundColor: "var(--bg-panel)",
    borderLeft: "1px solid var(--border)",
    boxShadow: "-18px 0 56px rgba(0,0,0,.22)",
    height: "100dvh",
    maxWidth: 450,
    overflow: "hidden",
    position: "relative",
    width: { default: "min(450px, 94vw)", "@media (max-width: 760px)": "100vw" },
  },
  close: {
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    color: "var(--text-muted)",
    cursor: "pointer",
    display: "flex",
    fontSize: 18,
    height: 30,
    justifyContent: "center",
    position: "absolute",
    right: 14,
    top: 14,
    width: 30,
    zIndex: 4,
  },
})
