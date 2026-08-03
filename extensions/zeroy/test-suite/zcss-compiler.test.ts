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

  it("normalizes Unicode NFC and platform newlines before hashing", () => {
    const result = run(`(function () {
      $design = zeroy_zcss_minimal_design_document();
      $composed = $design;
      $composed['typography']['bodyFamily'] = "Caf\\u{00e9}, sans-serif";
      $decomposed = $design;
      $decomposed['typography']['bodyFamily'] = "Cafe\\u{0301}, sans-serif";
      $compiled = zeroy_zcss_compile($composed);
      $equivalent = zeroy_zcss_compile($decomposed);
      return [
        $compiled['manifest']['designHash'],
        $equivalent['manifest']['designHash'],
        $compiled['css'],
        $equivalent['css'],
        zeroy_zcss_canonical_json(["value" => "first\\r\\nsecond\\rthird"]),
        zeroy_zcss_canonical_json(["value" => "first\\nsecond\\nthird"]),
      ];
    })()`);
    const [composedHash, decomposedHash, composedCss, decomposedCss, windows, unix] =
      result as string[];
    expect(composedHash).toBe(decomposedHash);
    expect(composedCss).toBe(decomposedCss);
    expect(windows).toBe(unix);
  });

  it("rejects unknown fields and malformed values with actionable paths", () => {
    const result = run(`(function () {
      $unknown = zeroy_zcss_minimal_design_document();
      $unknown['builderCss'] = 'body{}';
      $ratio = zeroy_zcss_minimal_design_document();
      $ratio['spacing']['scaleRatio'] = 1;
      $color = zeroy_zcss_minimal_design_document();
      $color['palette']['brand']['color'] = 'blue';
      $font = zeroy_zcss_minimal_design_document();
      $font['typography']['bodyFamily'] = 'url(https://invalid.example/font.woff2)';
      return [zeroy_zcss_compile($unknown), zeroy_zcss_compile($ratio), zeroy_zcss_compile($color), zeroy_zcss_compile($font)];
    })()`);
    const failures = result as Array<{
      ok: false;
      diagnostics: Array<{ code: string; path: string }>;
    }>;
    expect(failures.every((failure) => failure.ok === false)).toBe(true);
    expect(failures[0]?.diagnostics[0]?.code).toBe("zcss_keys_invalid");
    expect(failures[1]?.diagnostics.some(({ path }) => path === "/spacing/scaleRatio")).toBe(true);
    expect(failures[2]?.diagnostics.some(({ path }) => path === "/palette/brand/color")).toBe(true);
    expect(failures[3]?.diagnostics.some(({ path }) => path === "/typography/bodyFamily")).toBe(
      true,
    );
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

  it("keeps the palette and fluid scale output on its canonical golden surface", () => {
    const result = run(`(function () {
      $compiled = zeroy_zcss_compile(zeroy_zcss_minimal_design_document());
      $tokens = [];
      foreach ($compiled['manifest']['tokens'] as $token) $tokens[$token['name']] = $token['value'];
      return [
        'action' => $tokens['--z-color-action'],
        'onAction' => $tokens['--z-color-on-action'],
        'gutter' => $tokens['--z-gutter'],
        'heading1' => $tokens['--z-heading-1'],
        'spaceM' => $tokens['--z-space-m'],
        'textM' => $tokens['--z-text-m'],
      ];
    })()`);
    expect(result).toEqual({
      action: "#1f5eff",
      onAction: "#ffffff",
      gutter: "clamp(1rem, 0.666667rem + 0.092593vw, 2rem)",
      heading1: "clamp(3.814697rem, 3.655752rem + 0.044152vw, 4.291534rem)",
      spaceM: "clamp(0.5625rem, 0.46875rem + 0.026042vw, 0.84375rem)",
      textM: "clamp(1rem, 0.958333rem + 0.011574vw, 1.125rem)",
    });
  });

  it("accepts closed design-space boundaries while preserving a monotonic scale", () => {
    const result = run(`(function () {
      $minimum = zeroy_zcss_minimal_design_document();
      $minimum['typography'] = ['viewport' => ['minPx' => 240, 'maxPx' => 480], 'body' => ['minPx' => 12, 'maxPx' => 12], 'scaleRatio' => 1.05, 'headingScaleRatio' => 1.05, 'bodyLineHeight' => 1, 'headingLineHeight' => 0.9, 'bodyFamily' => 'A', 'headingFamily' => 'A'];
      $minimum['spacing'] = ['minPx' => 1, 'maxPx' => 1, 'scaleRatio' => 1.05, 'sectionMultiplier' => 2];
      $minimum['layout'] = ['contentWidth' => 480, 'textWidth' => 320, 'gutterMin' => 8, 'gutterMax' => 8];
      $minimum['shape'] = ['radiusBase' => 0, 'borderWidth' => 0, 'shadowStrength' => 0];
      $minimum['motion'] = ['durationFast' => 0, 'durationNormal' => 0, 'easingStandard' => 'linear'];
      $maximum = zeroy_zcss_minimal_design_document();
      $maximum['typography'] = ['viewport' => ['minPx' => 1600, 'maxPx' => 3840], 'body' => ['minPx' => 32, 'maxPx' => 40], 'scaleRatio' => 2, 'headingScaleRatio' => 2, 'bodyLineHeight' => 2.2, 'headingLineHeight' => 1.8, 'bodyFamily' => 'Noto Sans CJK SC', 'headingFamily' => 'Noto Sans CJK SC'];
      $maximum['spacing'] = ['minPx' => 32, 'maxPx' => 64, 'scaleRatio' => 3, 'sectionMultiplier' => 16];
      $maximum['layout'] = ['contentWidth' => 2400, 'textWidth' => 1200, 'gutterMin' => 64, 'gutterMax' => 128];
      $maximum['shape'] = ['radiusBase' => 48, 'borderWidth' => 8, 'shadowStrength' => 1];
      $maximum['motion'] = ['durationFast' => 2000, 'durationNormal' => 5000, 'easingStandard' => 'ease-in-out'];
      $compiled = zeroy_zcss_compile($minimum);
      $scale = zeroy_zcss_scale_tokens($compiled['design']);
      $minimums = [];
      foreach (['xs', 's', 'm', 'l', 'xl', 'xxl'] as $name) {
        preg_match('/(?:clamp\\()?([0-9.]+)rem/', $scale['--z-text-' . $name], $match);
        $minimums[] = (float) ($match[1] ?? -1);
      }
      $monotonic = true;
      for ($index = 1; $index < count($minimums); $index++) if ($minimums[$index - 1] >= $minimums[$index]) $monotonic = false;
      return ['minimum' => $compiled['ok'], 'maximum' => zeroy_zcss_compile($maximum)['ok'], 'monotonic' => $monotonic];
    })()`);
    expect(result).toEqual({ minimum: true, maximum: true, monotonic: true });
  });

  it("keeps every deterministic legal design sample compilable with monotonic fluid scales", () => {
    const result = run(`(function () {
      $sample = static function (int $seed, int $salt, float $minimum, float $maximum): float {
        $fraction = (($seed * 73 + $salt * 193) % 997) / 996;
        return $minimum + (($maximum - $minimum) * $fraction);
      };
      $monotonic = static function (array $tokens, string $prefix): bool {
        $previous = -INF;
        foreach (['xs', 's', 'm', 'l', 'xl', 'xxl'] as $name) {
          if (preg_match('/(?:clamp\\()?([0-9.]+)rem/', $tokens[$prefix . $name], $match) !== 1) return false;
          $current = (float) $match[1];
          if ($current <= $previous) return false;
          $previous = $current;
        }
        return true;
      };
      for ($seed = 1; $seed <= 128; $seed++) {
        $design = zeroy_zcss_minimal_design_document();
        $viewport_min = $sample($seed, 1, 320, 720);
        $design['typography']['viewport'] = ['minPx' => $viewport_min, 'maxPx' => $sample($seed, 2, 1200, 2800)];
        $body_min = $sample($seed, 3, 12, 24);
        $design['typography']['body'] = ['minPx' => $body_min, 'maxPx' => $sample($seed, 4, $body_min, 36)];
        $design['typography']['scaleRatio'] = $sample($seed, 5, 1.05, 1.7);
        $design['typography']['headingScaleRatio'] = $sample($seed, 6, 1.05, 1.7);
        $spacing_min = $sample($seed, 7, 1, 16);
        $design['spacing'] = ['minPx' => $spacing_min, 'maxPx' => $sample($seed, 8, $spacing_min, 48), 'scaleRatio' => $sample($seed, 9, 1.05, 2.2), 'sectionMultiplier' => $sample($seed, 10, 2, 12)];
        $content_width = $sample($seed, 11, 800, 1600);
        $gutter_min = $sample($seed, 12, 8, 40);
        $design['layout'] = ['contentWidth' => $content_width, 'textWidth' => $sample($seed, 13, 320, min(1000, $content_width)), 'gutterMin' => $gutter_min, 'gutterMax' => $sample($seed, 14, $gutter_min, 96)];
        $result = zeroy_zcss_compile($design);
        if (($result['ok'] ?? false) !== true) return ['ok' => false, 'seed' => $seed, 'diagnostics' => $result['diagnostics'] ?? []];
        $tokens = zeroy_zcss_scale_tokens($result['design']);
        if (!$monotonic($tokens, '--z-text-') || !$monotonic($tokens, '--z-space-')) return ['ok' => false, 'seed' => $seed, 'reason' => 'non-monotonic'];
      }
      return ['ok' => true, 'samples' => 128];
    })()`);
    expect(result).toEqual({ ok: true, samples: 128 });
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
