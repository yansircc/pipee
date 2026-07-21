import * as stylex from "@stylexjs/stylex"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ApplicationCommand } from "@/ui/interaction/ApplicationCommands"
import {
  applicationAriaHotkey,
  formatApplicationHotkey,
  runApplicationCommand,
} from "@/ui/interaction/ApplicationCommands"
import { useI18n } from "@/lib/i18n"

export function CommandPalette({
  commands,
  isMac,
  onClose,
}: {
  readonly commands: ReadonlyArray<ApplicationCommand>
  readonly isMac: boolean
  readonly onClose: () => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle === "" ? commands : commands.filter((command) => command.label.toLocaleLowerCase().includes(needle))
  }, [commands, query])
  useEffect(() => setActiveIndex(0), [query])
  useEffect(() => inputRef.current?.focus(), [])
  const execute = (command: ApplicationCommand) => {
    if (!command.enabled) return
    if (command.id !== "commandPalette.open") onClose()
    runApplicationCommand(command)
  }
  return (
    <div
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      {...stylex.props(styles.backdrop)}
    >
      <section role="dialog" aria-modal="true" aria-label={t("Commands")} {...stylex.props(styles.palette)}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setActiveIndex((index) => Math.min(visible.length - 1, index + 1))
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              setActiveIndex((index) => Math.max(0, index - 1))
            } else if (event.key === "Enter") {
              event.preventDefault()
              const command = visible[activeIndex]
              if (command !== undefined) execute(command)
            }
          }}
          placeholder={t("Search commands")}
          {...stylex.props(styles.search)}
        />
        <div role="listbox" aria-label={t("Application commands")} {...stylex.props(styles.list)}>
          {visible.map((command, index) => (
            <button
              key={command.id}
              data-command-id={command.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={!command.enabled}
              aria-keyshortcuts={command.hotkey ? applicationAriaHotkey(command.hotkey, isMac) : undefined}
              disabled={!command.enabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => execute(command)}
              {...stylex.props(styles.row, index === activeIndex && styles.rowActive)}
            >
              <span {...stylex.props(styles.identity)}>
                <strong>{command.label}</strong>
                {!command.enabled && command.disabledReason && <small>{command.disabledReason}</small>}
              </span>
              {command.hotkey && (
                <kbd {...stylex.props(styles.hotkey)}>{formatApplicationHotkey(command.hotkey, isMac)}</kbd>
              )}
            </button>
          ))}
          {visible.length === 0 && <div {...stylex.props(styles.empty)}>{t("No commands found")}</div>}
        </div>
      </section>
    </div>
  )
}

const styles = stylex.create({
  backdrop: {
    alignItems: "flex-start",
    background: "rgba(15, 18, 22, 0.28)",
    display: "flex",
    inset: 0,
    justifyContent: "center",
    paddingTop: "min(18vh, 150px)",
    position: "fixed",
    zIndex: "var(--layer-modal)",
  },
  palette: {
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    boxShadow: "var(--shadow-surface)",
    maxHeight: "min(520px, 70vh)",
    overflow: "hidden",
    width: "min(560px, calc(100vw - 24px))",
  },
  search: {
    background: "transparent",
    border: 0,
    borderBottom: "1px solid var(--border)",
    color: "var(--text)",
    font: "inherit",
    fontSize: 15,
    outline: "none",
    padding: "14px 16px",
    width: "100%",
  },
  list: { maxHeight: "min(440px, calc(70vh - 52px))", overflowY: "auto", padding: 6 },
  row: {
    alignItems: "center",
    background: "transparent",
    border: 0,
    borderRadius: 7,
    color: "var(--text)",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    minHeight: 46,
    padding: "7px 10px",
    textAlign: "left",
    width: "100%",
    ":disabled": { color: "var(--text-dim)", cursor: "not-allowed" },
  },
  rowActive: { background: "var(--bg-selected)" },
  identity: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  hotkey: { color: "var(--text-muted)", fontFamily: "inherit", fontSize: 11, marginLeft: 12 },
  empty: { color: "var(--text-dim)", padding: 20, textAlign: "center" },
})
