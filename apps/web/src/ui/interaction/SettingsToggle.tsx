import * as stylex from "@stylexjs/stylex"
import { Switch } from "react-aria-components"

interface SettingsToggleProps {
  readonly enabled: boolean
  readonly label: string
  readonly loading: boolean
  readonly onToggle: () => void
}

export function SettingsToggle({ enabled, label, loading, onToggle }: SettingsToggleProps) {
  return (
    <Switch
      aria-label={label}
      isDisabled={loading}
      isSelected={enabled}
      onChange={onToggle}
      {...stylex.props(styles.track, enabled && styles.trackSelected, loading && styles.loading)}
    >
      <span {...stylex.props(styles.thumb, enabled && styles.thumbSelected)} />
    </Switch>
  )
}

const styles = stylex.create({
  track: {
    alignItems: "center",
    backgroundColor: "var(--border)",
    border: "none",
    borderRadius: 11,
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    height: 22,
    outline: "none",
    padding: 3,
    transition: "background-color 0.15s",
    width: 40,
    ":focus-visible": {
      boxShadow: "0 0 0 2px color-mix(in srgb, var(--accent) 42%, transparent)",
    },
  },
  trackSelected: {
    backgroundColor: "var(--accent)",
  },
  loading: {
    cursor: "wait",
    opacity: 0.65,
  },
  thumb: {
    backgroundColor: "#fff",
    borderRadius: "50%",
    boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
    display: "block",
    height: 16,
    transform: "translateX(0)",
    transition: "transform 0.15s",
    width: 16,
  },
  thumbSelected: {
    transform: "translateX(18px)",
  },
})
