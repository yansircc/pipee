import { expect, it } from "vite-plus/test";
import packageJson from "../../package.json" with { type: "json" };
import viteConfig from "../../vite.config.js";

type Task = {
  readonly command: string | ReadonlyArray<string>;
};

const tasks = (
  viteConfig as {
    readonly run: { readonly tasks: Readonly<Record<string, Task>> };
  }
).run.tasks;

const lintOptions = (
  viteConfig as {
    readonly lint: {
      readonly options: { readonly typeAware: boolean; readonly typeCheck: boolean };
    };
  }
).lint.options;

it("requires verification and a real connector smoke before publishing", () => {
  expect(packageJson.files).toContain("dist/browser-extension");
  expect(packageJson.files).toContain("dist/pi");
  expect(packageJson.files).not.toContain("dist");
  expect(packageJson.files.filter((path) => path === "src" || path.startsWith("src/"))).toEqual([]);
  expect(packageJson).not.toHaveProperty("dependencies");
  expect(packageJson.pi.extensions).toEqual(["./dist/pi/extension.js"]);
  expect(packageJson.scripts.verify).toBe("pnpm run repo:verify && pnpm run pi:verify");
  expect(packageJson.scripts["pi:assets-build"]).toBe("node scripts/build.ts");
  expect(packageJson.scripts["release:check"]).toBe("node scripts/release-check.ts");
  expect(packageJson.scripts["release:archive-check"]).toContain("verify-distribution.mjs archive");
  expect(packageJson.scripts["release:platform-check"]).toContain(
    "verify-distribution.mjs platform",
  );
  expect(packageJson.scripts).not.toHaveProperty("release:public-check");
  expect(tasks.build?.command).toBe("pnpm run pi:build");
  expect(tasks["smoke:connector:release"]?.command).toBe(
    "node scripts/smoke-connector.ts --require-browser --no-sandbox",
  );
  expect(lintOptions).toEqual({ typeAware: true, typeCheck: false });
  expect(tasks["ci:verify"]?.command).toContain("vp run typecheck");
});
