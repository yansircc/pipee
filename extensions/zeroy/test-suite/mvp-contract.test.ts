import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const readFixture = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("zeroY MVP contract", () => {
  it("keeps localized node structure in JSON rather than executable theme code", () => {
    const schema = JSON.parse(readFixture("../mvp-theme/zeroy.schema.json")) as {
      readonly contract: string;
      readonly schemas: Record<
        string,
        { readonly nodes: Record<string, { readonly kind: string; readonly required: boolean }> }
      >;
    };

    expect(schema.contract).toBe("zeroy/theme-schema@1");
    expect(schema.schemas.showcase?.nodes).toMatchObject({
      title: { kind: "text", required: true },
      intro: { kind: "text", required: true },
    });
  });

  it("exposes only typed connector resources and no arbitrary PHP execution", () => {
    const plugin = readFixture("../wordpress-plugin/zeroy-runtime-connector.php");

    expect(plugin).toContain("register_rest_route('zeroy/v1', '/site'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/theme/file'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/locale/draft'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/locale/publish'");
    expect(plugin).not.toMatch(/eval\s*\(/);
  });
});
