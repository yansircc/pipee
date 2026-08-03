import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

const root = new URL("../wordpress-plugin/includes/zcss/", import.meta.url);
const modules = ["contract", "canonical-json", "css-ast", "style-surface"]
  .map((name) => new URL(`${name}.php`, root).pathname)
  .map((path) => `require ${JSON.stringify(path)};`)
  .join("\n");

const run = (expression: string): unknown => {
  const bootstrap = `
define('ABSPATH', __DIR__);
class WP_Error {
  public function __construct(private string $code, private string $message = '', private mixed $data = null) {}
  public function get_error_code(): string { return $this->code; }
  public function get_error_message(): string { return $this->message; }
  public function get_error_data(): mixed { return $this->data; }
}
function is_wp_error(mixed $value): bool { return $value instanceof WP_Error; }
function zeroy_runtime_error(string $code, string $message, int $status = 500, array $data = []): WP_Error { return new WP_Error($code, $message, ['status' => $status, ...$data]); }
function zeroy_runtime_decode_json(string $value): array|WP_Error { try { $decoded = json_decode($value, true, 512, JSON_THROW_ON_ERROR); return is_array($decoded) ? $decoded : zeroy_runtime_error('invalid_json', 'JSON object required.'); } catch (Throwable $error) { return zeroy_runtime_error('invalid_json', $error->getMessage()); } }
function zeroy_runtime_theme_runtime_manifest(string $directory): array { global $zcss_test_styles; return ['zcss' => ['styles' => $zcss_test_styles]]; }
${modules}
`;
  const output = execFileSync(
    "php",
    ["-r", `${bootstrap} echo json_encode(${expression}, JSON_THROW_ON_ERROR);`],
    {
      encoding: "utf8",
    },
  );
  return JSON.parse(output);
};

const surfaceResult = (files: Record<string, string>): unknown =>
  run(`(function () {
    global $zcss_test_styles;
    $files = json_decode(${JSON.stringify(JSON.stringify(files))}, true, 512, JSON_THROW_ON_ERROR);
    $zcss_test_styles = array_keys($files);
    $directory = sys_get_temp_dir() . '/zeroy-zcss-surface-' . bin2hex(random_bytes(8));
    mkdir($directory . '/assets/css', 0777, true);
    $generated = '';
    file_put_contents($directory . '/' . ZEROY_ZCSS_GENERATED_CSS_PATH, $generated);
    file_put_contents($directory . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH, json_encode([
      'contract' => ZEROY_ZCSS_COMPILED_CONTRACT,
      'compiler' => ['id' => ZEROY_ZCSS_COMPILER_ID],
      'designHash' => str_repeat('d', 64),
      'outputHash' => hash('sha256', $generated),
      'tokens' => [],
      'primitives' => [],
    ], JSON_THROW_ON_ERROR));
    foreach ($files as $path => $content) file_put_contents($directory . '/' . $path, $content);
    $result = zeroy_zcss_style_surface_from_directory($directory);
    $payload = is_wp_error($result) ? ['error' => $result->get_error_code(), 'data' => $result->get_error_data()] : $result;
    foreach ($zcss_test_styles as $path) unlink($directory . '/' . $path);
    unlink($directory . '/' . ZEROY_ZCSS_GENERATED_CSS_PATH);
    unlink($directory . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH);
    rmdir($directory . '/assets/css');
    rmdir($directory . '/assets');
    rmdir($directory);
    return $payload;
  })()`);

describe("ZCSS StyleSurface bounded AST", () => {
  it("enforces a single aggregate node budget across every manifest stylesheet", () => {
    const css = `${".component { color: red; }\n".repeat(5_000)}/* split by test fixture */`;
    const result = surfaceResult({
      "assets/css/one.css": css,
      "assets/css/two.css": `${css}.overflow { color: red; }`,
    });
    expect(result).toMatchObject({
      error: "zeroy_zcss_stylesheet_limit",
      data: { budget: { code: "zcss_css_node_limit", limit: 5_000 } },
    });
  });

  it("bounds declaration-derived projections across every manifest stylesheet", () => {
    const declarations = (prefix: string, count: number) =>
      `.component { ${Array.from({ length: count }, (_, index) => `--${prefix}-${index}: 0;`).join("")} }`;
    const result = surfaceResult({
      "assets/css/one.css": declarations("one", 7_500),
      "assets/css/two.css": declarations("two", 2_501),
    });
    expect(result).toMatchObject({
      error: "zeroy_zcss_stylesheet_limit",
      data: { budget: { code: "zcss_css_declaration_limit", limit: 2_500 } },
    });
  });

  it("projects namespace violations and unresolved compiler references without treating them as CSS ownership", () => {
    const result = surfaceResult({
      "assets/css/site.css":
        ".z-not-a-public-primitive { --z-not-a-public-property: red; color: var(--z-not-a-token); }",
    }) as {
      reservedNamespaceViolations: Array<{ code: string; name: string }>;
      undefinedReferences: string[];
    };
    expect(result.reservedNamespaceViolations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "zcss_reserved_class_unknown",
          name: ".z-not-a-public-primitive",
        }),
        expect.objectContaining({
          code: "zcss_reserved_property_redefined",
          name: "--z-not-a-public-property",
        }),
      ]),
    );
    expect(result.undefinedReferences).toContain("--z-not-a-token");
  });

  it("rejects unbounded stylesheet indirection and parser nesting", () => {
    const importResult = surfaceResult({ "assets/css/site.css": "@import url('other.css');" });
    expect(importResult).toMatchObject({ error: "zeroy_zcss_stylesheet_import_forbidden" });
    const nesting = `${"@media all {".repeat(65)}.component { color: red; }${"}".repeat(65)}`;
    const result = surfaceResult({ "assets/css/site.css": nesting });
    expect(result).toMatchObject({
      error: "zeroy_zcss_stylesheet_limit",
      data: { budget: { code: "zcss_css_nesting_limit", limit: 64 } },
    });
  });
});
