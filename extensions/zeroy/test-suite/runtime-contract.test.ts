import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import piZeroY from "../src/pi/extension.js";

const readFixture = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("zeroY localization runtime contract", () => {
  it("puts localization responsibility in ThemeSchema, not in locale documents", () => {
    const schema = JSON.parse(readFixture("../mvp-theme/zeroy.schema.json")) as {
      readonly contract: string;
      readonly schemas: Record<
        string,
        { readonly localization: { readonly contract: string; readonly rules: readonly unknown[] } }
      >;
      readonly localizationSubjects: Record<string, unknown>;
    };
    expect(schema.contract).toBe("zeroy/theme-schema@1");
    const home = schema.schemas.home;
    expect(home?.localization.contract).toBe("zeroy/localization-policy@1");
    expect(home?.localization.rules.length).toBeGreaterThan(0);
    expect(home).toHaveProperty("templateContent");
    expect(schema.localizationSubjects).toHaveProperty("siteCopy");
    expect(JSON.stringify(schema)).not.toContain("themeCopy");
    expect(JSON.stringify(schema)).not.toContain("nodes");
  });

  it("keeps the connector runtime as a composition root, not an implementation bucket", () => {
    const runtime = readFixture("../wordpress-plugin/includes/runtime.php");
    expect(runtime).toContain("theme/schema-runtime.php");
    expect(runtime).toContain("localization/template-content.php");
    expect(runtime).toContain("localization/migration.php");
    expect(runtime).not.toMatch(/\bfunction\s+zeroy_/);
  });

  it("confines retired locale documents to the one-shot bootstrap importer", () => {
    const requestReaders = [
      "../wordpress-plugin/includes/localization/locale-resolver.php",
      "../wordpress-plugin/includes/localization/translation-job.php",
      "../wordpress-plugin/includes/routes.php",
      "../wordpress-plugin/includes/theme/activation.php",
    ]
      .map(readFixture)
      .join("\n");
    expect(requestReaders).not.toContain("zeroy_localization_legacy_");
    expect(requestReaders).not.toContain("locale_heads");
    expect(requestReaders).not.toContain("locale_versions");

    const transition = [
      "../wordpress-plugin/includes/theme/initial-deployment.php",
      "../wordpress-plugin/includes/localization/migration.php",
      "../wordpress-plugin/includes/localization/migration/post-overlays.php",
    ]
      .map(readFixture)
      .join("\n");
    expect(transition).toContain("zeroy_localization_apply_legacy_migration");
    expect(transition).toContain("locale_heads");
    expect(transition).not.toContain("locale-version@2");
    expect(transition).not.toContain("theme-copy-version@2");
  });

  it("has one first-deployment writer for imported and uploaded Artifacts", () => {
    const bootstrap = readFixture("../wordpress-plugin/includes/theme/bootstrap.php");
    const initial = readFixture("../wordpress-plugin/includes/theme/initial-deployment.php");
    expect(bootstrap).toContain("zeroy_runtime_bootstrap_theme_deployment_from_artifact");
    expect(bootstrap).not.toContain("zeroy_runtime_table('theme_state')");
    expect(initial).toContain("zeroy_runtime_table('theme_state')");
    expect(initial).toContain("zeroy_localization_apply_legacy_migration");
  });

  it("runs content-writing upgrades only after WordPress functionality is initialized", () => {
    const connector = readFixture("../wordpress-plugin/zeroy-runtime-connector.php");
    expect(connector).toContain("add_action('init', 'zeroy_runtime_maybe_upgrade', 1)");
    expect(connector).not.toContain("add_action('plugins_loaded', 'zeroy_runtime_maybe_upgrade'");
  });

  it("repairs the one additive Overlay column without replaying dbDelta against existing tables", () => {
    const lifecycle = readFixture("../wordpress-plugin/includes/lifecycle.php");
    expect(lifecycle).toContain("if (!zeroy_runtime_table_exists(zeroy_runtime_table($name))) {");
    expect(lifecycle).toContain(
      "ALTER TABLE ' . zeroy_runtime_table('locale_overlay_heads') . ' ADD COLUMN published_at DATETIME NULL",
    );
    expect(lifecycle).toContain("zeroy_runtime_schema_is_current()");
    expect(lifecycle).toContain("zeroy_runtime_locale_overlay_heads_has_published_at()");
  });

  it("owns immutable Overlay history and exposes only generic ports", () => {
    const plugin = [
      "../wordpress-plugin/includes/runtime.php",
      "../wordpress-plugin/includes/lifecycle.php",
      "../wordpress-plugin/includes/localization/policy-contract.php",
      "../wordpress-plugin/includes/localization/locale-overlay-store.php",
      "../wordpress-plugin/includes/localization/translation-job.php",
      "../wordpress-plugin/includes/localization/locale-resolver.php",
      "../wordpress-plugin/includes/rest/routes.php",
      "../wordpress-plugin/includes/theme/activation.php",
    ]
      .map(readFixture)
      .join("\n");
    expect(plugin).toContain("locale_overlay_versions");
    expect(plugin).toContain("locale_overlay_heads");
    expect(plugin).toContain("zeroy/localization-policy@1");
    expect(plugin).toContain("zeroy/locale-overlay@1");
    expect(plugin).toContain("zeroy/translation-job@1");
    expect(plugin).toContain("/translation-job");
    expect(plugin).toContain("/translation");
    expect(plugin).toContain("theme_artifacts");
    expect(plugin).not.toMatch(/zeroy\/locale-version@2/);
    expect(plugin).not.toMatch(/zeroy\/theme-copy-version@2/);
    expect(plugin).not.toMatch(/eval\s*\(/);
  });

  it("registers exactly the read, checkout, deploy, and content agent boundaries", () => {
    const tools: string[] = [];
    const handlers: string[] = [];
    const pi = {
      registerTool: (tool: { readonly name: string }) => tools.push(tool.name),
      on: (event: string) => handlers.push(event),
    } as unknown as ExtensionAPI;
    piZeroY(pi);
    expect(tools).toEqual([
      "zeroy_inspect",
      "zeroy_theme_checkout",
      "zeroy_theme_push",
      "zeroy_content_apply",
    ]);
    expect(handlers).toEqual(["session_start", "session_shutdown"]);
  });
});
