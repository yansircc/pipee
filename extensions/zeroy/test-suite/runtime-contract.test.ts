import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import piZeroY from "../src/pi/extension.js";

const readFixture = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("zeroY SiteRelease hard cut", () => {
  it("keeps localization responsibility in ThemeSchema rather than locale documents", () => {
    const schema = JSON.parse(readFixture("../mvp-theme/zeroy.schema.json")) as {
      readonly contract: string;
      readonly schemas: Record<string, { readonly localization: { readonly contract: string } }>;
    };
    expect(schema.contract).toBe("zeroy/theme-schema@1");
    expect(schema.schemas.home?.localization.contract).toBe("zeroy/localization-policy@1");
    expect(JSON.stringify(schema)).not.toContain("themeCopy");
  });

  it("uses SiteRelease as the only active composition and keeps Connector recovery code separate", () => {
    const connector = readFixture("../wordpress-plugin/zeroy-runtime-connector.php");
    const store = readFixture("../wordpress-plugin/includes/site-release/store.php");
    const request = readFixture("../wordpress-plugin/includes/site-release/request-runtime.php");
    expect(connector).toContain("site-release/store.php");
    expect(connector).toContain("site-logic/artifact-store.php");
    expect(connector).not.toContain("theme/activation.php");
    expect(store).toContain("site_release_state");
    expect(store).toContain("theme_artifact_id");
    expect(store).toContain("site_logic_artifact_id");
    expect(request).toContain("zeroy_runtime_is_connector_safe_request");
    expect(request).toContain("require $bootstrap");
    expect(request).toContain("require $functions");
  });

  it("derives ThemeContract and rejects Theme business writes without a case table", () => {
    const compiler = readFixture("../wordpress-plugin/includes/theme/contract-compiler.php");
    const verifier = readFixture("../wordpress-plugin/includes/site-release/static-verifier.php");
    expect(compiler).toContain("zeroy_runtime_compile_theme_contract");
    expect(compiler).toContain("zeroy_runtime_capability_requirements_satisfied");
    expect(verifier).toContain("theme_persistence_forbidden");
    expect(verifier).toContain("site_logic_rendering_forbidden");
    expect(verifier).not.toContain("zeroy_weixin");
  });

  it("gives Pi one site workspace and three release operations", () => {
    const tools: string[] = [];
    const handlers: string[] = [];
    const pi = {
      registerTool: (tool: { readonly name: string }) => tools.push(tool.name),
      on: (event: string) => handlers.push(event),
    } as unknown as ExtensionAPI;
    piZeroY(pi);
    expect(tools).toEqual([
      "zeroy_inspect",
      "zeroy_site_checkout",
      "zeroy_site_verify",
      "zeroy_site_push",
      "zeroy_content_apply",
    ]);
    expect(handlers).toEqual(["session_start", "session_shutdown"]);
  });

  it("keeps Pi registration as composition rather than a deployment implementation bucket", () => {
    const registration = readFixture("../src/pi/extension.ts");
    expect(registration.split("\n").length).toBeLessThan(190);
    expect(registration).toContain('from "./site-tools.js"');
    expect(registration).not.toContain("connectorGet(");
    expect(registration).not.toContain("connectorPost(");
    expect(registration).not.toContain("prepareSitePush(");
  });
});
