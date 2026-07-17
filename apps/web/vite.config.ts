import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite-plus"
import pkg from "./package.json" with { type: "json" }

const root = fileURLToPath(new URL(".", import.meta.url))
const piPackage = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "../package.json"),
    "utf8",
  ),
) as { readonly version: string }

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
        command: ["vp check", "vp run ci:typecheck", "vp test", "vp run ci:effect", "pnpm test:e2e:run"],
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
    ...(mode === "test"
      ? []
      : [
          tanstackStart({ spa: { enabled: true } }),
          nitro({
            plugins: [fileURLToPath(new URL("./src/server/nitro-lifecycle.ts", import.meta.url))],
            traceDeps: ["@earendil-works/pi-coding-agent*", "@earendil-works/pi-ai*"],
          }),
        ]),
    react(),
    tailwindcss(),
  ],
}))
