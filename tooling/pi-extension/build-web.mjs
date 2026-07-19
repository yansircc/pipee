import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite-plus";

const root = resolve(process.argv[2] ?? process.cwd());
const entry = resolve(root, "src/web/index.html");
assert.ok(existsSync(entry), "missing src/web/index.html");

await build({
  configFile: false,
  root: resolve(root, "src/web"),
  base: "./",
  build: {
    outDir: resolve(root, "dist/web"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rolldownOptions: { input: entry },
  },
});
