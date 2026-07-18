import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import stylex from "@stylexjs/unplugin"
import react from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import { defineConfig, type Plugin } from "vite-plus"
import pkg from "./package.json" with { type: "json" }

const root = fileURLToPath(new URL(".", import.meta.url))
const piPackage = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "../package.json"),
    "utf8",
  ),
) as { readonly version: string }

const extensionAssetDevForwarder = {
  name: "pi-web:extension-asset-dev-forwarder",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = request.url as string | undefined
      if (
        url === undefined ||
        !url.startsWith("/extension-assets/") ||
        new URL(url, "http://pi-web.local").pathname.endsWith("/")
      ) {
        next()
        return
      }
      const host = request.headers.host as string | undefined
      if (host === undefined) {
        next()
        return
      }
      void fetch(`http://${host}${url}/`, { headers: { accept: request.headers.accept ?? "*/*" } }).then(
        async (forwarded) => {
          response.statusCode = forwarded.status
          forwarded.headers.forEach((value, key) => response.setHeader(key, value))
          response.end(Buffer.from(await forwarded.arrayBuffer()))
        },
        () => next(),
      )
    })
  },
} satisfies Plugin

export default defineConfig(({ mode }) => ({
  fmt: {
    ignorePatterns: [".output/**", "coverage/**", "src/routeTree.gen.ts", "test-results/**"],
    printWidth: 120,
    semi: false,
    singleQuote: false,
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: [".output/**", "coverage/**", "src/routeTree.gen.ts", "test-results/**"],
    plugins: ["oxc", "typescript", "unicorn", "react"],
    options: {
      typeAware: true,
      // The @effect/tsgo-patched compiler owns TypeScript and Effect diagnostics.
      typeCheck: false,
    },
    rules: {
      "no-control-regex": "off",
      "react/exhaustive-deps": "warn",
      "react/rules-of-hooks": "error",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  run: {
    tasks: {
      "ci:typecheck": {
        command: "tsc --noEmit",
        cache: false,
      },
      "ci:effect": {
        command: "effect-scan . --strict --output gate-json --evidence .effect-scan --fail-on-suppression-drift",
        cache: false,
      },
      "ci:verify": {
        command: [
          "vp check",
          "vp run ci:typecheck",
          "vp test",
          "vp run ci:effect",
          "pnpm check:ui-governance",
          "pnpm test:e2e:run",
        ],
        cache: false,
      },
    },
  },
  resolve: {
    alias: { "@": `${root}src` },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __PI_VERSION__: JSON.stringify(piPackage.version),
  },
  server: {
    port: 30141,
  },
  ssr: {
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
  },
  plugins: [
    extensionAssetDevForwarder,
    ...(mode === "test"
      ? []
      : [
          tanstackStart({ spa: { enabled: true } }),
          nitro({
            plugins: [fileURLToPath(new URL("./src/server/nitro-lifecycle.ts", import.meta.url))],
            traceDeps: ["@earendil-works/pi-coding-agent*", "@earendil-works/pi-ai*"],
          }),
        ]),
    // Migrated styles still contain hundreds of shorthand declarations; the default resolver silently drops them.
    // Compiler expansion is safer than duplicating its algorithm by hand. Remove this mode only after the source has
    // no shorthand keys and the pre-migration visual contract has been re-baselined.
    stylex.vite({ styleResolution: "legacy-expand-shorthands" }),
    react(),
  ],
}))
