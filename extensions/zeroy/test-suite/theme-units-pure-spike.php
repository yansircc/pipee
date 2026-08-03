<?php

define('ABSPATH', __DIR__ . '/');

$root = dirname(__DIR__) . '/wordpress-plugin/includes';
foreach (['zcss/contract', 'theme-units/contract', 'theme-units/canonical', 'theme-units/decoder', 'theme-units/source-resolver', 'theme-units/graph', 'theme-units/linker-php', 'theme-units/linker-css', 'theme-units/linker-js', 'theme-units/compiler'] as $module) require_once $root . '/' . $module . '.php';

function theme_units_spike_assert(bool $condition, string $message): void
{
    if (!$condition) throw new RuntimeException($message);
}

$catalog = zeroy_theme_units_catalog_entries();
theme_units_spike_assert(count($catalog) === 6, 'Initial catalog does not contain exactly six witnessed units.');
$program = ['contract' => ZEROY_THEME_PROGRAM_CONTRACT, 'units' => array_map(
    static fn(array $entry): array => ['kind' => 'catalog', 'id' => $entry['id'], 'integrity' => $entry['integrity']],
    array_values($catalog),
)];
$resolved = zeroy_theme_units_resolve_sources(__DIR__, $program);
theme_units_spike_assert($resolved['ok'] === true, 'Initial catalog did not resolve.');
$first = zeroy_theme_units_compile_resolved($program, $resolved['value']);
theme_units_spike_assert($first['ok'] === true, 'Initial catalog did not compile.');
for ($iteration = 0; $iteration < 1000; $iteration++) {
    $again = zeroy_theme_units_compile_resolved($program, $resolved['value']);
    theme_units_spike_assert($again['value']['outputs'] === $first['value']['outputs'], 'Repeated ThemeProgram compilation drifted.');
}
theme_units_spike_assert(isset($first['value']['outputs'][ZEROY_THEME_UNIT_PROGRAM_PATH]), 'Compiled program manifest is absent.');
theme_units_spike_assert(str_contains($first['value']['outputs'][ZEROY_THEME_UNIT_PHP_PATH], "require_once __DIR__ . '/vendor/"), 'PHP linker did not vendor source.');
theme_units_spike_assert(!str_contains(zeroy_theme_units_canonical_json($first['value']['manifest']), __DIR__), 'Compiled program leaks a host path.');

fwrite(STDOUT, "zeroY Theme Units pure compiler spike passed.\n");
