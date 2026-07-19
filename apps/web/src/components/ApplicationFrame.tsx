import * as stylex from "@stylexjs/stylex"
import { Link, Outlet, useSearch } from "@tanstack/react-router"

export function ApplicationFrame() {
  const search = useSearch({ strict: false }) as { readonly session?: string }
  const sharedSearch = search.session === undefined ? {} : { session: search.session }
  return (
    <div {...stylex.props(styles.frame)}>
      <nav {...stylex.props(styles.navigation)}>
        <div {...stylex.props(styles.brand)}>Pi</div>
        <Link
          to="/"
          search={sharedSearch}
          {...stylex.props(styles.item)}
          activeProps={stylex.props(styles.itemActive)}
          activeOptions={{ exact: true }}
        >
          <span aria-hidden>◌</span>
          <span>对话</span>
        </Link>
        <Link
          to="/extensions"
          {...stylex.props(styles.item)}
          activeProps={stylex.props(styles.itemActive)}
          activeOptions={{ includeSearch: false }}
        >
          <span aria-hidden>◇</span>
          <span>拓展</span>
        </Link>
      </nav>
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
    flexDirection: { default: "column", "@media (min-width: 641px)": "row" },
    height: "100dvh",
    minHeight: 0,
  },
  navigation: {
    alignItems: { default: "center", "@media (min-width: 641px)": "stretch" },
    backgroundColor: "var(--bg-panel)",
    borderBottom: { default: "1px solid var(--border)", "@media (min-width: 641px)": 0 },
    borderRight: { default: 0, "@media (min-width: 641px)": "1px solid var(--border)" },
    display: "flex",
    flexDirection: { default: "row", "@media (min-width: 641px)": "column" },
    flexShrink: 0,
    gap: 4,
    paddingBlock: { default: 6, "@media (min-width: 641px)": 12 },
    paddingInline: 8,
    width: { default: "auto", "@media (min-width: 641px)": 96 },
  },
  brand: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: { default: 0, "@media (min-width: 641px)": 12 },
    marginRight: { default: "auto", "@media (min-width: 641px)": 0 },
    paddingInline: 8,
  },
  item: {
    alignItems: "center",
    borderRadius: 8,
    color: { default: "var(--text-muted)", ":hover": "var(--text)" },
    display: "flex",
    fontSize: 14,
    gap: 8,
    paddingBlock: 8,
    paddingInline: 12,
    textDecoration: "none",
    transition: "background-color 120ms, color 120ms",
    backgroundColor: { default: "transparent", ":hover": "var(--bg-hover)" },
  },
  itemActive: {
    backgroundColor: "var(--bg-selected)",
    color: "var(--text)",
  },
  content: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
})
