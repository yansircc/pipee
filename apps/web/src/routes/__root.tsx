import type { ReactNode } from "react"
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
        <Scripts />
      </body>
    </html>
  )
}

function RootNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-text">
      <h1 className="text-2xl font-semibold">Not Found</h1>
      <Link to="/" className="text-accent hover:underline">
        Pi Agent Web
      </Link>
    </main>
  )
}
