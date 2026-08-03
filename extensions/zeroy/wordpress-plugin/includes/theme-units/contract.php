<?php

defined('ABSPATH') || exit;

const ZEROY_THEME_PROGRAM_CONTRACT = 'zeroy/theme-program@1';
const ZEROY_THEME_UNIT_CONTRACT = 'zeroy/theme-unit@1';
const ZEROY_COMPILED_THEME_PROGRAM_CONTRACT = 'zeroy/compiled-theme-program@1';
const ZEROY_THEME_UNIT_COMPILER_ID = 'zeroy/theme-unit-compiler@1';
const ZEROY_THEME_UNIT_COMPILER_VERSION = '1.0.0';
const ZEROY_THEME_UNIT_SURFACE_CONTRACT = 'zeroy/theme-unit-surface@1';
const ZEROY_THEME_PROGRAM_SOURCE_PATH = 'zeroy.units.json';
const ZEROY_THEME_UNIT_GENERATED_ROOT = 'assets/generated/theme-units';
const ZEROY_THEME_UNIT_PROGRAM_PATH = ZEROY_THEME_UNIT_GENERATED_ROOT . '/program.json';
const ZEROY_THEME_UNIT_PHP_PATH = ZEROY_THEME_UNIT_GENERATED_ROOT . '/bootstrap.php';
const ZEROY_THEME_UNIT_CSS_PATH = ZEROY_THEME_UNIT_GENERATED_ROOT . '/styles.css';
const ZEROY_THEME_UNIT_JS_PATH = ZEROY_THEME_UNIT_GENERATED_ROOT . '/bootstrap.js';
const ZEROY_THEME_UNIT_VENDOR_ROOT = ZEROY_THEME_UNIT_GENERATED_ROOT . '/vendor';

function zeroy_theme_units_policy(): array
{
    return [
        'contract' => 'zeroy/theme-unit-policy@1',
        'maxUnits' => 128,
        'maxDependencies' => 512,
        'maxGraphDepth' => 32,
        'maxFilesPerUnit' => 64,
        'maxSourceBytesPerUnit' => 2 * 1024 * 1024,
        'maxSourceBytes' => 32 * 1024 * 1024,
        'maxExportsPerUnit' => 32,
        'maxPropsPerUnit' => 64,
        'maxSlotsPerUnit' => 32,
        'maxTextLength' => 512,
        'behaviors' => ['disclosure', 'dialog'],
    ];
}

function zeroy_runtime_theme_generated_path_rules(): array
{
    return [
        ['kind' => 'exact', 'path' => ZEROY_ZCSS_GENERATED_CSS_PATH],
        ['kind' => 'exact', 'path' => ZEROY_ZCSS_COMPILED_MANIFEST_PATH],
        ['kind' => 'prefix', 'path' => ZEROY_THEME_UNIT_GENERATED_ROOT . '/'],
    ];
}

function zeroy_runtime_theme_generated_path(string $path): bool
{
    foreach (zeroy_runtime_theme_generated_path_rules() as $rule) {
        if ($rule['kind'] === 'exact' && $path === $rule['path']) return true;
        if ($rule['kind'] === 'prefix' && str_starts_with($path, $rule['path'])) return true;
    }
    return false;
}

function zeroy_runtime_theme_generated_paths(): array
{
    return array_map(
        static fn(array $rule): string => $rule['kind'] === 'prefix' ? $rule['path'] . '**' : $rule['path'],
        zeroy_runtime_theme_generated_path_rules(),
    );
}

function zeroy_theme_units_authoring_contract(): array
{
    return [
        'contract' => 'zeroy/theme-unit-authoring-contract@1',
        'program' => [
            'contract' => ZEROY_THEME_PROGRAM_CONTRACT,
            'path' => ZEROY_THEME_PROGRAM_SOURCE_PATH,
            'exactFields' => ['contract', 'units'],
            'sources' => [
                'local' => ['exactFields' => ['kind', 'manifest'], 'manifest' => 'Safe regular ThemeArtifact path ending in unit.json.'],
                'catalog' => ['exactFields' => ['kind', 'id', 'integrity'], 'integrity' => 'Exact sha256-<64 lowercase hex> catalog identity.'],
            ],
        ],
        'unit' => [
            'contract' => ZEROY_THEME_UNIT_CONTRACT,
            'idPattern' => '^[a-z][a-z0-9-]{0,63}/[a-z][a-z0-9-]{0,63}$',
            'exactFields' => ['contract', 'id', 'php?', 'styles?', 'scripts?', 'dependencies?', 'interface?', 'behaviors?'],
            'php' => ['entrypoints' => 'Ordered safe relative .php paths.', 'exports' => ['name' => 'Stable public name.', 'symbol' => 'Fully-qualified PHP function symbol.']],
            'interface' => ['props' => 'Map of prop name to {description, required}.', 'slots' => 'List of {name, description, required}.'],
            'behaviors' => zeroy_theme_units_policy()['behaviors'],
        ],
        'limits' => zeroy_theme_units_policy(),
        'generatedPaths' => zeroy_runtime_theme_generated_paths(),
        'handwrittenRoot' => 'A ThemeArtifact without zeroy.units.json is permanently valid and uses no Theme Unit runtime.',
    ];
}
