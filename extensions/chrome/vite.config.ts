import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    options: {
      typeAware: true,
      // tsc remains the single compiler gate because it is the process that loads the
      // Effect language-service diagnostics configured in tsconfig.json.
      typeCheck: false,
    },
  },
  test: {
    include: ["test-suite/unit/**/*.test.ts"],
  },
  run: {
    tasks: {
      build: {
        command: "pnpm run pi:build",
        cache: false,
      },
      typecheck: {
        command: "tsc --noEmit",
        cache: false,
      },
      knip: {
        command: "knip --include files,dependencies,exports",
        cache: false,
      },
      "lint:effect": {
        command: "pnpm run scan:effect",
        cache: false,
      },
      "smoke:connector": {
        command: "node scripts/smoke-connector.ts",
        cache: false,
      },
      "smoke:connector:release": {
        command: "node scripts/smoke-connector.ts --require-browser --no-sandbox",
        cache: false,
      },
      "ci:verify": {
        command: ["vp check", "vp run typecheck", "vp test", "vp run knip", "vp run lint:effect"],
        cache: false,
      },
    },
  },
});
