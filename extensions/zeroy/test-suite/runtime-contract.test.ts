import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import piZeroY from "../src/pi/extension.js";
import { activeSession, run, startSession, stopSession } from "../src/pi/session.js";

const readFixture = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("zeroY SiteRelease hard cut", () => {
  it("keeps the production registration independent from a site ThemeSchema", () => {
    const registration = readFixture("../src/pi/extension.ts");
    expect(registration).not.toContain("test-suite/fixtures");
    expect(registration).not.toContain("zeroy.schema.json");
  });

  it("uses SiteRelease as the only active composition and keeps Connector recovery code separate", () => {
    const connector = readFixture("../wordpress-plugin/zeroy-runtime-connector.php");
    const store = readFixture("../wordpress-plugin/includes/site-release/store.php");
    const request = readFixture("../wordpress-plugin/includes/site-release/request-runtime.php");
    const resolver = readFixture("../wordpress-plugin/includes/localization/locale-resolver.php");
    const activation = readFixture("../wordpress-plugin/includes/site-release/activation.php");
    const draft = readFixture("../wordpress-plugin/includes/site-release/draft.php");
    const draftInspection = readFixture(
      "../wordpress-plugin/includes/site-release/draft-inspection.php",
    );
    const releaseRest = readFixture("../wordpress-plugin/includes/site-release/rest.php");
    const proof = readFixture("../wordpress-plugin/includes/site-release/proof.php");
    const snapshotCompiler = readFixture(
      "../wordpress-plugin/includes/site-release/snapshot-compiler.php",
    );
    const browserSmoke = readFixture("../wordpress-plugin/includes/site-release/browser-smoke.php");
    const templateContent = readFixture(
      "../wordpress-plugin/includes/localization/template-content.php",
    );
    const translationJob = readFixture(
      "../wordpress-plugin/includes/localization/translation-job.php",
    );
    expect(connector).toContain("site-release/store.php");
    expect(connector).toContain("site-logic/artifact-store.php");
    expect(connector).not.toContain("theme/activation.php");
    expect(store).toContain("site_release_state");
    expect(store).toContain("theme_artifact_id");
    expect(store).toContain("site_logic_artifact_id");
    expect(store).toContain("draft_id");
    expect(draft).toContain("ZEROY_SITE_DRAFT_CONTRACT");
    expect(draft).toContain("zeroy_runtime_stage_site_draft_operation");
    expect(draftInspection).toContain("zeroy_runtime_with_site_draft_artifact_directory");
    expect(draftInspection).toContain("zeroy_runtime_compile_theme_contract_from_directories");
    expect(releaseRest).toContain("/site-drafts");
    expect(releaseRest).toContain("/site-draft-stages");
    expect(releaseRest).toContain("zeroy_runtime_site_release_owned_candidate");
    expect(releaseRest).toContain("WHERE state IN ('active', 'superseded')");
    expect(store).toContain("zeroy_runtime_site_release_artifact_owned_candidate");
    expect(releaseRest).not.toContain(
      "/site-drafts', $permission + ['methods' => WP_REST_Server::CREATABLE",
    );
    expect(request).toContain("zeroy_runtime_is_connector_safe_request");
    expect(request).toContain("zeroy_runtime_request_is_candidate_site_release");
    expect(request).toContain("require $bootstrap");
    expect(request).toContain("require $functions");
    expect(resolver).toContain("zeroy_runtime_request_is_candidate_site_release()");
    expect(resolver).not.toContain("zeroy_runtime_is_candidate_artifact_request");
    expect(activation).toContain("zeroy_runtime_acquire_content_lease()");
    expect(activation).toContain("zeroy_localization_apply_overlay_reconciliation($schema)");
    expect(activation.indexOf("zeroy_runtime_apply_site_draft_content_operations")).toBeLessThan(
      activation.indexOf("zeroy_localization_apply_overlay_reconciliation($schema)"),
    );
    expect(
      activation.indexOf("zeroy_localization_apply_overlay_reconciliation($schema)"),
    ).toBeLessThan(activation.indexOf("activation.before-active-pointer"));
    expect(proof).toContain("zeroy_runtime_snapshot_required_content_checks");
    expect(proof).toContain("zeroy_runtime_snapshot_scenarios");
    expect(proof).toContain("zeroy_localization_plan_overlay_reconciliation");
    expect(proof).toContain("reconciliationChecks");
    expect(connector).not.toContain("site-release/content-verifier.php");
    expect(snapshotCompiler).toContain("zeroy_runtime_snapshot_overlay_from_head");
    expect(snapshotCompiler).toContain("zeroy_runtime_snapshot_required_content_failure");
    expect(browserSmoke).toContain("candidate_empty_image_source");
    expect(templateContent).toContain("zeroy_localization_template_content_required_violations");
    expect(translationJob).toContain("zeroy_localization_value_is_present");
  });

  it("derives ThemeContract and rejects Theme business writes without a case table", () => {
    const compiler = readFixture("../wordpress-plugin/includes/theme/contract-compiler.php");
    const verifier = readFixture("../wordpress-plugin/includes/site-release/static-verifier.php");
    expect(compiler).toContain("zeroy_runtime_compile_theme_contract");
    expect(compiler).toContain("zeroy_runtime_capability_requirements_satisfied");
    expect(verifier).toContain("theme_persistence_forbidden");
    expect(verifier).toContain("site_logic_rendering_forbidden");
    expect(verifier).toContain("theme_connector_lifecycle_forbidden");
    expect(verifier).toContain("site_logic_connector_lifecycle_forbidden");
    expect(verifier).not.toContain("zeroy_weixin");
  });

  it("gives Pi one remote inspect/stage/commit surface", () => {
    const tools: string[] = [];
    const handlers: string[] = [];
    const pi = {
      registerTool: (tool: { readonly name: string }) => tools.push(tool.name),
      on: (event: string) => handlers.push(event),
    } as unknown as ExtensionAPI;
    piZeroY(pi);
    expect(tools).toEqual([
      "zeroy_inspect",
      "zeroy_artifact_stage",
      "zeroy_content_stage",
      "zeroy_site_commit",
    ]);
    expect(handlers).toEqual(["session_start", "session_shutdown"]);
  });

  it("keeps Pi registration as composition rather than a deployment implementation bucket", () => {
    const registration = readFixture("../src/pi/extension.ts");
    expect(registration.split("\n").length).toBeLessThan(190);
    expect(registration).toContain('from "./stage-tools.js"');
    expect(registration).not.toContain("connectorGet(");
    expect(registration).not.toContain("connectorPost(");
    expect(registration).not.toContain("prepareSitePush(");
  });

  it.effect("does not make companion reads part of a headless tool session", () => {
    const previousSites = process.env.ZEROY_SITES;
    const pi = {} as ExtensionAPI;
    let refreshes = 0;
    return Effect.sync(() => {
      process.env.ZEROY_SITES = JSON.stringify([
        {
          siteId: "headless-site",
          label: "Headless site",
          endpoint: "https://example.test",
          connectionKey: "headless-connection-key",
        },
      ]);
    }).pipe(
      Effect.andThen(
        Effect.promise(() =>
          run(
            startSession(
              pi,
              {
                hasUI: false,
                ui: {},
                sessionManager: { getSessionId: () => "headless-session" },
              } as ExtensionContext,
              () => Effect.sync(() => void refreshes++),
            ),
          ),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(refreshes).toBe(0);
          expect(activeSession(pi)?.surface).toBeUndefined();
        }),
      ),
      Effect.ensuring(
        Effect.promise(async () => {
          const active = activeSession(pi);
          if (active) await run(stopSession(pi, active));
          if (previousSites === undefined) delete process.env.ZEROY_SITES;
          else process.env.ZEROY_SITES = previousSites;
        }),
      ),
    );
  });
});
