import * as stylex from "@stylexjs/stylex"
import { Effect } from "effect"
import { useEffect, useRef } from "react"
import { runBrowser } from "@/browser/api-client"
import { BrowserPlatform } from "@/browser/browser-platform"
import { useBrowserPreferences } from "@/browser/preferences-react"
import { useTheme } from "@/hooks/useTheme"
import { useI18n } from "@/lib/i18n"
import { SettingsToggle } from "@/ui/interaction/SettingsToggle"

export function ApplicationSettingsPopover({ onClose }: { readonly onClose: () => void }) {
  const { locale, setLocale, t } = useI18n()
  const { isDark, toggleTheme } = useTheme()
  const { preferences, updatePreferences } = useBrowserPreferences()
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target as Element
      if (popoverRef.current?.contains(target) || target.closest("[data-settings-trigger]")) return
      onClose()
    }
    return runBrowser(BrowserPlatform.pipe(Effect.flatMap((browser) => browser.onDocumentMouseDown(close))), {
      onSuccess: () => undefined,
    })
  }, [onClose])

  return (
    <div ref={popoverRef} role="dialog" aria-label={t("Settings")} {...stylex.props(styles.popover)}>
      <header {...stylex.props(styles.header)}>
        <strong>{t("Application settings")}</strong>
        <small>{t("Application preferences only")}</small>
      </header>
      <div {...stylex.props(styles.body)}>
        <div {...stylex.props(styles.row)}>
          <strong>{t("Theme")}</strong>
          <button
            type="button"
            {...stylex.props(styles.action)}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
            }}
          >
            {t(isDark ? "Dark" : "Light")}
          </button>
        </div>
        <div {...stylex.props(styles.row)}>
          <strong>{t("Language")}</strong>
          <button
            type="button"
            {...stylex.props(styles.action)}
            onClick={() => setLocale(locale === "zh-CN" ? "en" : "zh-CN")}
          >
            {locale === "zh-CN" ? "简体中文" : "English"}
          </button>
        </div>
        <div {...stylex.props(styles.row)}>
          <strong>{t("Sound")}</strong>
          <SettingsToggle
            enabled={preferences.soundEnabled}
            label={t("Completion sound")}
            loading={false}
            onToggle={() => updatePreferences((current) => ({ ...current, soundEnabled: !current.soundEnabled }))}
          />
        </div>
      </div>
    </div>
  )
}

const styles = stylex.create({
  popover: {
    backgroundColor: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 11,
    boxShadow: "var(--shadow-surface)",
    display: "grid",
    gridTemplateRows: "52px auto",
    left: { default: 32, "@media (max-width: 760px)": 10 },
    overflow: "hidden",
    position: "fixed",
    top: 52,
    width: { default: 250, "@media (max-width: 760px)": "calc(min(310px, 88vw) - 20px)" },
    zIndex: "var(--layer-popover)",
  },
  header: {
    borderBottom: "1px solid var(--border-soft)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    paddingInline: 14,
  },
  body: { display: "flex", flexDirection: "column", gap: 0, overflow: "auto", padding: 8 },
  row: {
    alignItems: "center",
    borderRadius: 7,
    display: "flex",
    justifyContent: "space-between",
    minHeight: 40,
    paddingInline: 7,
    ":hover": { backgroundColor: "var(--bg-hover)" },
  },
  action: {
    backgroundColor: "transparent",
    border: "none",
    borderRadius: 7,
    color: "var(--text)",
    cursor: "pointer",
    fontSize: 12,
    padding: "5px 0",
    ":hover": { backgroundColor: "var(--bg-selected)" },
  },
})
