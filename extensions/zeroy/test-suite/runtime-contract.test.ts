import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import piZeroY from "../src/pi/extension.js";

const readFixture = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("zeroY runtime contract", () => {
  it("keeps localized node structure in non-executable JSON rather than theme PHP", () => {
    const schema = JSON.parse(readFixture("../mvp-theme/zeroy.schema.json")) as {
      readonly contract: string;
      readonly collections: Record<
        string,
        { readonly kind: string; readonly route: string; readonly schemaId: string }
      >;
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
    expect(schema.collections).toMatchObject({
      machines: { kind: "post-archive", route: "machine", schemaId: "machine" },
      services: { kind: "post-archive", route: "service", schemaId: "service" },
    });
  });

  it("owns locale history as version pointers and exposes only constrained Connector ports", () => {
    const plugin =
      readFixture("../wordpress-plugin/includes/runtime.php") +
      readFixture("../wordpress-plugin/includes/rest.php");

    expect(plugin).toContain("locale_versions");
    expect(plugin).toContain("locale_heads");
    expect(plugin).toContain("route_reservations");
    expect(plugin).toContain("collection_route_reservations");
    expect(plugin).toContain("schema_state");
    expect(plugin).toContain("zeroy_runtime_deploy_candidate_schema");
    expect(plugin).toContain("zeroy_locale_entities");
    expect(plugin).toContain("zeroy_collection_items");
    expect(plugin).toContain("search_projection");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/site'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/theme-files'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/locale-content'");
    expect(plugin).toContain("register_rest_route('zeroy/v1', '/integrity'");
    expect(plugin).not.toMatch(/eval\s*\(/);
    expect(plugin).not.toContain("zeroy_mvp_");
  });

  it("registers exactly the read, code-write, and content-write agent boundaries", () => {
    const tools: string[] = [];
    const handlers: string[] = [];
    const pi = {
      registerTool: (tool: { readonly name: string }) => tools.push(tool.name),
      on: (event: string) => handlers.push(event),
    } as unknown as ExtensionAPI;

    piZeroY(pi);

    expect(tools).toEqual(["zeroy_inspect", "zeroy_theme_apply", "zeroy_content_apply"]);
    expect(handlers).toEqual(["session_start", "session_shutdown"]);
  });
});
