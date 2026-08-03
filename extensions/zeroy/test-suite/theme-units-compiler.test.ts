import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const root = new URL("../wordpress-plugin/includes/", import.meta.url);
const modules = [
  "zcss/contract",
  "theme-units/contract",
  "theme-units/canonical",
  "theme-units/decoder",
  "theme-units/source-resolver",
  "theme-units/graph",
  "theme-units/linker-php",
  "theme-units/linker-css",
  "theme-units/linker-js",
  "theme-units/compiler",
].map((name) => new URL(`${name}.php`, root).pathname);

const run = (expression: string): unknown => {
  const requires = modules.map((path) => `require ${JSON.stringify(path)};`).join("\n");
  return JSON.parse(
    execFileSync(
      "php",
      [
        "-r",
        `define('ABSPATH', __DIR__); ${requires} echo json_encode(${expression}, JSON_THROW_ON_ERROR);`,
      ],
      { encoding: "utf8" },
    ),
  );
};

describe("ThemeUnit source graph compiler", () => {
  it("resolves the immutable catalog and compiles deterministic vendored bytes", () => {
    const result = run(`(function () {
      $catalog = zeroy_theme_units_catalog_entries();
      $program = ['contract' => ZEROY_THEME_PROGRAM_CONTRACT, 'units' => array_map(
        static fn($entry) => ['kind' => 'catalog', 'id' => $entry['id'], 'integrity' => $entry['integrity']],
        array_values($catalog),
      )];
      $resolved = zeroy_theme_units_resolve_sources(__DIR__, $program);
      $first = zeroy_theme_units_compile_resolved($program, $resolved['value']);
      $again = zeroy_theme_units_compile_resolved($program, $resolved['value']);
      return [
        'catalog' => array_map(static fn($entry) => ['id' => $entry['id'], 'integrity' => $entry['integrity']], array_values($catalog)),
        'ok' => $resolved['ok'] && $first['ok'],
        'same' => $first['value']['outputs'] === $again['value']['outputs'],
        'order' => $first['value']['manifest']['order'],
        'graphHash' => $first['value']['manifest']['graphHash'],
        'outputHash' => $first['value']['manifest']['outputHash'],
        'paths' => array_keys($first['value']['outputs']),
        'php' => $first['value']['outputs'][ZEROY_THEME_UNIT_PHP_PATH],
      ];
    })()`);
    expect(result).toMatchObject({ ok: true, same: true });
    expect((result as { catalog: unknown[] }).catalog).toHaveLength(6);
    expect((result as { graphHash: string }).graphHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((result as { outputHash: string }).outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect((result as { paths: string[] }).paths).toContain(
      "assets/generated/theme-units/program.json",
    );
    expect((result as { php: string }).php).toContain(
      "require_once __DIR__ . '/vendor/zeroy--dialog/render.php';",
    );
    expect(JSON.stringify(result)).not.toContain(process.cwd());
  });

  it("uses one graph algebra for stable ordering, missing dependencies and cycles", () => {
    const result = run(`(function () {
      $unit = static fn($id, $dependencies) => ['id' => $id, 'sourceHash' => hash('sha256', $id), 'dependencies' => $dependencies, 'php' => null];
      $diamond = [
        'site/root' => $unit('site/root', ['site/left', 'site/right']),
        'site/right' => $unit('site/right', ['site/base']),
        'site/left' => $unit('site/left', ['site/base']),
        'site/base' => $unit('site/base', []),
      ];
      $first = zeroy_theme_units_compile_graph($diamond);
      $same = true;
      for ($i = 0; $i < 1000; $i++) $same = $same && zeroy_theme_units_compile_graph($diamond)['value']['graphHash'] === $first['value']['graphHash'];
      $missing = ['site/root' => $unit('site/root', ['site/missing'])];
      $cycle = ['site/a' => $unit('site/a', ['site/b']), 'site/b' => $unit('site/b', ['site/a'])];
      return ['order' => $first['value']['order'], 'same' => $same, 'missing' => zeroy_theme_units_compile_graph($missing), 'cycle' => zeroy_theme_units_compile_graph($cycle)];
    })()`);
    expect(result).toMatchObject({
      order: ["site/base", "site/left", "site/right", "site/root"],
      same: true,
      missing: { ok: false, diagnostics: [{ code: "theme_unit_dependency_missing" }] },
      cycle: { ok: false, diagnostics: [{ code: "theme_unit_dependency_cycle" }] },
    });
  });

  it("fails closed on sourceHash, floating catalog references and unknown behavior", () => {
    const result = run(`(function () {
      $base = ['contract' => ZEROY_THEME_UNIT_CONTRACT, 'id' => 'site/card'];
      return [
        zeroy_theme_units_decode_unit([...$base, 'sourceHash' => str_repeat('0', 64)]),
        zeroy_theme_units_decode_program(['contract' => ZEROY_THEME_PROGRAM_CONTRACT, 'units' => [['kind' => 'catalog', 'id' => 'zeroy/dialog', 'integrity' => '^1']]]),
        zeroy_theme_units_decode_unit([...$base, 'behaviors' => ['carousel']]),
      ];
    })()`);
    expect(result).toMatchObject([
      { ok: false, diagnostics: [{ code: "theme_unit_source_hash_forbidden" }] },
      { ok: false, diagnostics: [{ code: "theme_unit_source_invalid" }] },
      { ok: false, diagnostics: [{ code: "theme_unit_behavior_unknown" }] },
    ]);
  });

  it("keeps compiler modules free of request, database, network and time ownership", () => {
    const source = modules.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(source).not.toMatch(
      /current_time|time\s*\(|wp_remote|\$_(?:GET|POST|COOKIE|REQUEST)|get_option|update_option|postmeta|\$wpdb|curl_|random_int/u,
    );
  });
});
