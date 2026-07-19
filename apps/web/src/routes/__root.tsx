import type { ReactNode } from "react"
import * as stylex from "@stylexjs/stylex"
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router"
import "katex/dist/katex.min.css"
import { I18nProvider } from "@/lib/i18n"
import { BrowserPreferencesProvider } from "@/browser/preferences-react"
import appCss from "@/styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "google", content: "notranslate" },
      { title: "Pi Agent Web" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      ...(import.meta.env.DEV ? [{ rel: "stylesheet", href: "/virtual:stylex.css" }] : []),
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: Root,
  notFoundComponent: RootNotFound,
})

function Root() {
  return (
    <RootDocument>
      <BrowserPreferencesProvider>
        <I18nProvider>
          <Outlet />
        </I18nProvider>
      </BrowserPreferencesProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body translate="no" className="notranslate">
        {children}
        {import.meta.env.DEV && <script type="module" src="/@id/virtual:stylex:runtime" />}
        <Scripts />
      </body>
    </html>
  )
}

function RootNotFound() {
  return (
    <main {...stylex.props(styles.notFound)}>
      <h1 {...stylex.props(styles.notFoundTitle)}>Not Found</h1>
      <Link to="/" {...stylex.props(styles.notFoundLink)}>
        Pi Agent Web
      </Link>
    </main>
  )
}

const styles = stylex.create({
  notFound: {
    alignItems: "center",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    justifyContent: "center",
    minHeight: "100vh",
    paddingInline: 24,
    textAlign: "center",
  },
  notFoundTitle: { fontSize: 24, fontWeight: 600 },
  notFoundLink: {
    color: "var(--accent)",
    textDecoration: { default: "none", ":hover": "underline" },
  },
})
