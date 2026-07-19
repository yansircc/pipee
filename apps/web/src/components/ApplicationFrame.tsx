import * as stylex from "@stylexjs/stylex"
import { Outlet } from "@tanstack/react-router"

export function ApplicationFrame() {
  return (
    <div {...stylex.props(styles.frame)}>
      <main {...stylex.props(styles.content)}>
        <Outlet />
      </main>
    </div>
  )
}

const styles = stylex.create({
  frame: {
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    display: "flex",
    height: "100dvh",
    minHeight: 0,
  },
  content: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
})
