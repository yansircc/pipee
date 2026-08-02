<?php

define('ABSPATH', __DIR__ . '/');

$root = dirname(__DIR__) . '/wordpress-plugin/includes/zcss';
foreach (['contract', 'canonical-json', 'decoder', 'color', 'fluid-scale', 'tokens', 'primitives', 'compiler', 'css-ast'] as $module) require_once $root . '/' . $module . '.php';

function zcss_spike_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

function zcss_spike_reverse_keys(mixed $value): mixed
{
    if (!is_array($value)) return $value;
    if (array_is_list($value)) return array_map('zcss_spike_reverse_keys', $value);
    $keys = array_reverse(array_keys($value));
    $result = [];
    foreach ($keys as $key) $result[$key] = zcss_spike_reverse_keys($value[$key]);
    return $result;
}

$design = zeroy_zcss_minimal_design_document();
$first = zeroy_zcss_compile($design);
$reordered = zeroy_zcss_compile(zcss_spike_reverse_keys($design));
zcss_spike_assert($first['ok'] === true, 'Minimal design did not compile.');
zcss_spike_assert($reordered['ok'] === true, 'Reordered design did not compile.');
zcss_spike_assert($first['css'] === $reordered['css'], 'CSS depends on JSON key order.');
zcss_spike_assert($first['manifestJson'] === $reordered['manifestJson'], 'Compiled contract depends on JSON key order.');
for ($iteration = 0; $iteration < 1000; $iteration++) {
    $again = zeroy_zcss_compile($design);
    zcss_spike_assert($again['css'] === $first['css'] && $again['manifestJson'] === $first['manifestJson'], 'Repeated compilation drifted.');
}

$invalid_ratio = $design;
$invalid_ratio['spacing']['scaleRatio'] = 1;
zcss_spike_assert(zeroy_zcss_compile($invalid_ratio)['ok'] === false, 'Degenerate ratio did not fail closed.');
$invalid_color = $design;
$invalid_color['palette']['brand']['color'] = 'blue';
zcss_spike_assert(zeroy_zcss_compile($invalid_color)['ok'] === false, 'Invalid color did not fail closed.');
$invalid_range = $design;
$invalid_range['typography']['viewport'] = ['minPx' => 1440, 'maxPx' => 360];
zcss_spike_assert(zeroy_zcss_compile($invalid_range)['ok'] === false, 'Invalid viewport did not fail closed.');
zcss_spike_assert(!str_contains($first['css'], date('Y')) && !str_contains($first['css'], __DIR__), 'Generated output contains machine or time identity.');
zcss_spike_assert(str_contains($first['css'], '.z-container') && str_contains($first['css'], '.z-grid') && str_contains($first['css'], 'prefers-reduced-motion'), 'Core primitive output is incomplete.');
zcss_spike_assert(zeroy_zcss_contrast('#ffffff', '#111827') >= 4.5, 'Core surface pair does not meet contrast threshold.');
$parsed_css = zeroy_zcss_parse_css($first['css']);
zcss_spike_assert($parsed_css['ok'] === true, 'Generated CSS does not parse through the CandidateProof AST boundary.');
$published_properties = array_fill_keys(array_column($first['manifest']['tokens'], 'name'), true);
foreach ($first['manifest']['primitives'] as $primitive) foreach ($primitive['configurableProperties'] as $property) $published_properties[$property] = true;
$generated_references = [];
zeroy_zcss_walk_css_nodes($parsed_css['nodes'], static function (array $node) use (&$generated_references): void {
    foreach ($node['declarations'] ?? [] as $declaration) foreach (zeroy_zcss_css_identifiers($declaration['value'], '--z-') as $reference) $generated_references[$reference] = true;
});
zcss_spike_assert(array_diff(array_keys($generated_references), array_keys($published_properties)) === [], 'Core CSS references a token or configurable property absent from its compiled contract.');

$fixture_output = getenv('ZCSS_SPIKE_OUTPUT');
if (is_string($fixture_output) && $fixture_output !== '') {
    $fixture_source = __DIR__ . '/fixtures/zcss-spike';
    if (!is_dir($fixture_output . '/assets/css') && !mkdir($fixture_output . '/assets/css', 0777, true) && !is_dir($fixture_output . '/assets/css')) {
        throw new RuntimeException('Could not create temporary ZCSS fixture output.');
    }
    foreach (['index.php', 'assets/css/site.css'] as $path) {
        if (!copy($fixture_source . '/' . $path, $fixture_output . '/' . $path)) throw new RuntimeException('Could not copy ZCSS fixture ' . $path . '.');
    }
    if (file_put_contents($fixture_output . '/assets/css/zcss.generated.css', $first['css'], LOCK_EX) !== strlen($first['css'])) {
        throw new RuntimeException('Could not write temporary generated CSS.');
    }
}

fwrite(STDOUT, "zeroY ZCSS pure compiler spike passed.\n");
