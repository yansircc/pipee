import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = new URL("../wordpress-plugin/includes/zcss/", import.meta.url);
const modules = [
  "contract",
  "canonical-json",
  "decoder",
  "color",
  "fluid-scale",
  "tokens",
  "primitives",
  "compiler",
  "css-ast",
].map((name) => new URL(`${name}.php`, root).pathname);
const compilerModules = modules.slice(0, 8);

const compilerSourceHash = (): string =>
  createHash("sha256")
    .update(
      compilerModules
        .map((path) => {
          const source = readFileSync(path, "utf8").replace(
            /const ZEROY_ZCSS_COMPILER_SOURCE_HASH = '[0-9a-f]*';/u,
            "const ZEROY_ZCSS_COMPILER_SOURCE_HASH = '';",
          );
          return `${basename(path)}\0${source.replace(/\r\n/g, "\n")}`;
        })
        .join("\0"),
    )
    .digest("hex");

const run = (expression: string): unknown => {
  const requires = modules.map((path) => `require ${JSON.stringify(path)};`).join("\n");
  const output = execFileSync(
    "php",
    [
      "-r",
      `define('ABSPATH', __DIR__); ${requires} echo json_encode(${expression}, JSON_THROW_ON_ERROR);`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
};

describe("ZCSS pure compiler", () => {
  it("binds compiler identity to the complete pure compiler source closure", () => {
    expect(run("zeroy_zcss_compiler_source_hash()")).toBe(compilerSourceHash());
  });

  it("is deterministic across input key order and repeated execution", () => {
    const result = run(`(function () {
      $design = zeroy_zcss_minimal_design_document();
      $reverse = function ($value) use (&$reverse) {
        if (!is_array($value)) return $value;
        if (array_is_list($value)) return array_map($reverse, $value);
        $out = [];
        foreach (array_reverse(array_keys($value)) as $key) $out[$key] = $reverse($value[$key]);
        return $out;
      };
      $a = zeroy_zcss_compile($design);
      $b = zeroy_zcss_compile($reverse($design));
      return [
        'ok' => $a['ok'] && $b['ok'],
        'sameCss' => $a['css'] === $b['css'],
        'sameManifest' => $a['manifestJson'] === $b['manifestJson'],
        'designHash' => $a['manifest']['designHash'],
        'outputHash' => $a['manifest']['outputHash'],
        'sourceHash' => $a['manifest']['compiler']['sourceHash'],
      ];
    })()`);
    expect(result).toMatchObject({ ok: true, sameCss: true, sameManifest: true });
    for (const key of ["designHash", "outputHash", "sourceHash"] as const) {
      expect((result as Record<string, string>)[key]).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it("rejects unknown fields and malformed values with actionable paths", () => {
    const result = run(`(function () {
      $unknown = zeroy_zcss_minimal_design_document();
      $unknown['builderCss'] = 'body{}';
      $ratio = zeroy_zcss_minimal_design_document();
      $ratio['spacing']['scaleRatio'] = 1;
      $color = zeroy_zcss_minimal_design_document();
      $color['palette']['brand']['color'] = 'blue';
      return [zeroy_zcss_compile($unknown), zeroy_zcss_compile($ratio), zeroy_zcss_compile($color)];
    })()`);
    const failures = result as Array<{
      ok: false;
      diagnostics: Array<{ code: string; path: string }>;
    }>;
    expect(failures.every((failure) => failure.ok === false)).toBe(true);
    expect(failures[0]?.diagnostics[0]?.code).toBe("zcss_keys_invalid");
    expect(failures[1]?.diagnostics.some(({ path }) => path === "/spacing/scaleRatio")).toBe(true);
    expect(failures[2]?.diagnostics.some(({ path }) => path === "/palette/brand/color")).toBe(true);
  });

  it("emits the fixed primitive and accessibility surface", () => {
    const result = run(`(function () {
      $compiled = zeroy_zcss_compile(zeroy_zcss_minimal_design_document());
      return [
        'classes' => array_column($compiled['manifest']['primitives'], 'className'),
        'tokenCount' => count($compiled['manifest']['tokens']),
        'css' => $compiled['css'],
      ];
    })()`) as { classes: string[]; tokenCount: number; css: string };
    expect(result.classes).toEqual([
      "z-container",
      "z-section",
      "z-stack",
      "z-cluster",
      "z-grid",
      "z-sidebar",
      "z-switcher",
      "z-content-grid",
      "z-reel",
      "z-visually-hidden",
    ]);
    expect(result.tokenCount).toBeGreaterThan(70);
    expect(result.css).toContain(":focus-visible");
    expect(result.css).toContain("prefers-reduced-motion");
    expect(result.css).not.toContain(process.cwd());
  });

  it("keeps all production modules independent from time, network, request and WordPress state", () => {
    const source = modules.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(
      /current_time|time\s*\(|wp_remote|\$_(?:GET|POST|COOKIE|REQUEST)|get_option|update_option|random|wp_generate_uuid4/u,
    );
  });

  it("parses complex CSS into rules and declarations without selector regex heuristics", () => {
    const result = run(`(function () {
      $css = <<<'CSS'
@container card (inline-size > 30rem) {
  .machine-card:is(:hover, :focus-within) > [data-part="media"] {
    --machine-gap: clamp(1rem, 2vw, 2rem);
    color: var(--z-color-on-surface);
  }
}
@supports (display: grid) { .archive-grid { display: grid; } }
CSS;
      $parsed = zeroy_zcss_parse_css($css);
      $rules = [];
      zeroy_zcss_walk_css_nodes($parsed['nodes'], function ($node) use (&$rules) {
        if ($node['type'] === 'rule') $rules[] = [$node['prelude'], $node['declarations']];
      });
      return ['ok' => $parsed['ok'], 'rules' => $rules];
    })()`);
    expect(result).toMatchObject({ ok: true });
    expect((result as { rules: unknown[] }).rules).toHaveLength(2);
  });
});
