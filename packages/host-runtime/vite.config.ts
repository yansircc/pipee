import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
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
