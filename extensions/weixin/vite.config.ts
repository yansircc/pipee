import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["dist/**", "scripts/release/**"],
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      // The @effect/tsgo-patched compiler owns Effect diagnostics.
      typeCheck: false,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
  run: {
    tasks: {
      "ci:typecheck": {
        command: "tsc --noEmit",
        cache: false,
      },
      "ci:effect": {
        command:
          "effect-scan . --strict --output gate-json --evidence .effect-scan --fail-on-suppression-drift",
        cache: false,
      },
      "ci:verify": {
        command: ["vp check", "vp run ci:typecheck", "vp test", "vp run ci:effect"],
        cache: false,
      },
    },
  },
});
