<?php

defined('ABSPATH') || exit;

function zeroy_runtime_theme_units_compiled_manifest(string $theme_directory): array|null|WP_Error
{
    $path = rtrim($theme_directory, '/') . '/' . ZEROY_THEME_UNIT_PROGRAM_PATH;
    if (!is_file($path)) return null;
    if (is_link($path)) return zeroy_runtime_error('theme_program_compiled_invalid', 'Compiled ThemeProgram manifest must be a regular pinned ThemeArtifact file.', 409);
    $decoded = zeroy_runtime_decode_json((string) file_get_contents($path));
    if (
        is_wp_error($decoded) || !zeroy_runtime_is_keyed_map($decoded) ||
        array_diff(array_keys($decoded), ['contract', 'compiler', 'programSourceHash', 'graphHash', 'order', 'edgeCount', 'units', 'outputs', 'outputHash']) !== [] ||
        ($decoded['contract'] ?? null) !== ZEROY_COMPILED_THEME_PROGRAM_CONTRACT ||
        ($decoded['compiler']['id'] ?? null) !== ZEROY_THEME_UNIT_COMPILER_ID ||
        !is_string($decoded['compiler']['version'] ?? null) || !is_string($decoded['compiler']['sourceHash'] ?? null) ||
        preg_match('/\A[0-9a-f]{64}\z/', (string) ($decoded['programSourceHash'] ?? '')) !== 1 ||
        preg_match('/\A[0-9a-f]{64}\z/', (string) ($decoded['graphHash'] ?? '')) !== 1 ||
        preg_match('/\A[0-9a-f]{64}\z/', (string) ($decoded['outputHash'] ?? '')) !== 1 ||
        !is_array($decoded['order'] ?? null) || !array_is_list($decoded['order']) ||
        !is_array($decoded['units'] ?? null) || !array_is_list($decoded['units']) ||
        !is_array($decoded['outputs'] ?? null) || !array_is_list($decoded['outputs'])
    ) return zeroy_runtime_error('theme_program_compiled_invalid', 'Pinned ThemeArtifact has an invalid compiled ThemeProgram manifest.', 409);
    $output_entries = [];
    foreach ($decoded['outputs'] as $entry) {
        if (!is_array($entry) || array_diff(array_keys($entry), ['path', 'hash', 'bytes']) !== [] || !is_string($entry['path'] ?? null) || !zeroy_runtime_theme_generated_path($entry['path']) || $entry['path'] === ZEROY_THEME_UNIT_PROGRAM_PATH || preg_match('/\A[0-9a-f]{64}\z/', (string) ($entry['hash'] ?? '')) !== 1 || !is_int($entry['bytes'] ?? null) || $entry['bytes'] < 0) return zeroy_runtime_error('theme_program_compiled_invalid', 'Compiled ThemeProgram contains an invalid output descriptor.', 409);
        $actual = rtrim($theme_directory, '/') . '/' . $entry['path'];
        $hash = is_file($actual) && !is_link($actual) ? hash_file('sha256', $actual) : false;
        $bytes = is_file($actual) ? filesize($actual) : false;
        if (!is_string($hash) || !is_int($bytes) || $bytes !== $entry['bytes'] || !hash_equals($entry['hash'], $hash)) return zeroy_runtime_error('theme_program_output_invalid', 'Pinned ThemeArtifact ThemeProgram output bytes do not match their compiled identity.', 409, ['path' => $entry['path']]);
        $output_entries[] = $entry;
    }
    if (!hash_equals($decoded['outputHash'], zeroy_theme_units_hash($output_entries))) return zeroy_runtime_error('theme_program_output_invalid', 'Compiled ThemeProgram output set hash is invalid.', 409);
    return $decoded;
}

function zeroy_runtime_theme_unit_surface_from_directory(string $theme_directory): array|WP_Error
{
    $manifest = zeroy_runtime_theme_units_compiled_manifest($theme_directory);
    if (is_wp_error($manifest)) return $manifest;
    if ($manifest === null) return ['contract' => ZEROY_THEME_UNIT_SURFACE_CONTRACT, 'state' => 'handwritten-only', 'compiler' => null, 'programSourceHash' => null, 'graphHash' => null, 'units' => [], 'outputs' => [], 'diagnostics' => []];
    return [
        'contract' => ZEROY_THEME_UNIT_SURFACE_CONTRACT,
        'state' => 'compiled',
        'compiler' => $manifest['compiler'],
        'programSourceHash' => $manifest['programSourceHash'],
        'graphHash' => $manifest['graphHash'],
        'units' => array_map(static fn(array $unit): array => array_intersect_key($unit, array_flip(['id', 'sourceHash', 'dependencies', 'exports', 'styles', 'scripts', 'interface', 'behaviors', 'provenance'])), $manifest['units']),
        'outputs' => $manifest['outputs'],
        'diagnostics' => [],
    ];
}

function zeroy_runtime_theme_unit_compiled_assets(string $theme_directory): array|WP_Error
{
    $manifest = zeroy_runtime_theme_units_compiled_manifest($theme_directory);
    if (is_wp_error($manifest)) return $manifest;
    if ($manifest === null) return ['themeProgram' => null, 'phpBootstrap' => null, 'stylesheets' => [], 'scripts' => [], 'hashes' => []];
    $entries = array_column($manifest['outputs'], null, 'path');
    $stylesheets = isset($entries[ZEROY_THEME_UNIT_CSS_PATH]) ? [ZEROY_THEME_UNIT_CSS_PATH] : [];
    $scripts = isset($entries[ZEROY_THEME_UNIT_JS_PATH]) ? [ZEROY_THEME_UNIT_JS_PATH] : [];
    $php = isset($entries[ZEROY_THEME_UNIT_PHP_PATH]) ? ZEROY_THEME_UNIT_PHP_PATH : null;
    return [
        'themeProgram' => [
            'contract' => ZEROY_COMPILED_THEME_PROGRAM_CONTRACT,
            'compiler' => $manifest['compiler'],
            'programSourceHash' => $manifest['programSourceHash'],
            'graphHash' => $manifest['graphHash'],
            'units' => array_map(static fn(array $unit): array => ['id' => $unit['id'], 'sourceHash' => $unit['sourceHash'], 'dependencies' => $unit['dependencies'], 'exports' => $unit['exports'], 'behaviors' => $unit['behaviors']], $manifest['units']),
        ],
        'phpBootstrap' => $php,
        'stylesheets' => $stylesheets,
        'scripts' => $scripts,
        'hashes' => array_column($manifest['outputs'], 'hash', 'path'),
    ];
}
