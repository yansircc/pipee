<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_compiler_source_hash(): string
{
    $modules = ['contract.php', 'canonical.php', 'decoder.php', 'source-resolver.php', 'graph.php', 'linker-php.php', 'linker-css.php', 'linker-js.php', 'compiler.php'];
    $sources = [];
    foreach ($modules as $module) $sources[$module] = hash_file('sha256', __DIR__ . '/' . $module);
    return zeroy_theme_units_hash($sources);
}

function zeroy_theme_units_compile_resolved(array $program, array $units, array $global_styles = []): array
{
    $graph = zeroy_theme_units_compile_graph($units);
    if (!$graph['ok']) return $graph;
    $owned_styles = [];
    foreach ($units as $id => $unit) {
        $root = ($unit['provenance']['kind'] ?? null) === 'local' ? dirname((string) $unit['provenance']['manifest']) : null;
        foreach ($unit['styles'] as $style) {
            $source_path = $root === null ? null : $root . '/' . $style;
            if ($source_path !== null && in_array($source_path, $global_styles, true)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_style_owner_duplicate', '/units/' . $id . '/styles', 'A stylesheet is owned by both a ThemeUnit and ThemeManifest.', 'Remove the unit stylesheet from zeroy.theme.json zcss.styles; the unit linker is its only owner.')]];
            $owned_styles[] = $id . ':' . $style;
        }
    }
    $outputs = [];
    foreach ($graph['value']['order'] as $id) foreach ($units[$id]['files'] as $file) {
        $path = ZEROY_THEME_UNIT_VENDOR_ROOT . '/' . zeroy_theme_units_vendor_segment($id) . '/' . $file['path'];
        if (isset($outputs[$path])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_generated_collision', '/units/' . $id, 'Two unit files map to the same vendored output.', 'Use unique ThemeUnit IDs and source paths.')]];
        $outputs[$path] = $file['bytes'];
    }
    $php = zeroy_theme_units_link_php($units, $graph['value']['order']);
    $css = zeroy_theme_units_link_css($units, $graph['value']['order']);
    $js = zeroy_theme_units_link_js($units, $graph['value']['order']);
    if ($php !== null) $outputs[ZEROY_THEME_UNIT_PHP_PATH] = $php;
    if ($css !== null) $outputs[ZEROY_THEME_UNIT_CSS_PATH] = $css;
    if ($js !== null) $outputs[ZEROY_THEME_UNIT_JS_PATH] = $js;
    ksort($outputs, SORT_STRING);
    $output_entries = array_map(static fn(string $path, string $bytes): array => ['path' => $path, 'hash' => hash('sha256', $bytes), 'bytes' => strlen($bytes)], array_keys($outputs), array_values($outputs));
    $compiled_units = [];
    foreach ($graph['value']['order'] as $id) {
        $unit = $units[$id];
        $compiled_units[] = [
            'id' => $id,
            'sourceHash' => $unit['sourceHash'],
            'dependencies' => $unit['dependencies'],
            'files' => array_map(static fn(array $file): array => ['path' => $file['path'], 'hash' => $file['hash'], 'bytes' => strlen($file['bytes'])], $unit['files']),
            'exports' => $unit['php']['exports'] ?? [],
            'styles' => $unit['styles'],
            'scripts' => $unit['scripts'],
            'interface' => $unit['interface'],
            'behaviors' => $unit['behaviors'],
            'provenance' => $unit['provenance'],
        ];
    }
    $program_source_hash = zeroy_theme_units_hash([
        'program' => $program,
        'units' => array_map(static fn(array $unit): array => ['id' => $unit['id'], 'sourceHash' => $unit['sourceHash']], $compiled_units),
    ]);
    $manifest = [
        'contract' => ZEROY_COMPILED_THEME_PROGRAM_CONTRACT,
        'compiler' => ['id' => ZEROY_THEME_UNIT_COMPILER_ID, 'version' => ZEROY_THEME_UNIT_COMPILER_VERSION, 'sourceHash' => zeroy_theme_units_compiler_source_hash()],
        'programSourceHash' => $program_source_hash,
        'graphHash' => $graph['value']['graphHash'],
        'order' => $graph['value']['order'],
        'edgeCount' => $graph['value']['edgeCount'],
        'units' => $compiled_units,
        'outputs' => $output_entries,
        'outputHash' => zeroy_theme_units_hash($output_entries),
    ];
    $outputs[ZEROY_THEME_UNIT_PROGRAM_PATH] = zeroy_theme_units_canonical_json($manifest);
    ksort($outputs, SORT_STRING);
    return ['ok' => true, 'value' => ['manifest' => $manifest, 'outputs' => $outputs]];
}

function zeroy_theme_units_remove_generated_tree(string $theme_directory): void
{
    $root = rtrim($theme_directory, '/') . '/' . ZEROY_THEME_UNIT_GENERATED_ROOT;
    if (!is_dir($root) || is_link($root)) return;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $entry) {
        if (!$entry instanceof SplFileInfo) continue;
        $entry->isDir() ? rmdir($entry->getPathname()) : unlink($entry->getPathname());
    }
    rmdir($root);
}

function zeroy_theme_units_wp_error(array $result): WP_Error
{
    $diagnostics = $result['diagnostics'] ?? [];
    $first = $diagnostics[0] ?? ['code' => 'theme_program_invalid', 'message' => 'ThemeProgram compilation failed.'];
    return zeroy_runtime_error((string) $first['code'], (string) $first['message'], 409, ['diagnostics' => $diagnostics]);
}

function zeroy_runtime_compile_theme_units_directory(string $theme_directory): array|null|WP_Error
{
    $program_path = rtrim($theme_directory, '/') . '/' . ZEROY_THEME_PROGRAM_SOURCE_PATH;
    if (!is_file($program_path)) {
        zeroy_theme_units_remove_generated_tree($theme_directory);
        return null;
    }
    if (is_link($program_path)) return zeroy_runtime_error('theme_program_invalid', 'zeroy.units.json must be a regular ThemeArtifact file.', 409);
    $program_json = zeroy_theme_units_read_json_file($program_path, '/');
    if (!$program_json['ok']) return zeroy_theme_units_wp_error($program_json);
    $program = zeroy_theme_units_decode_program($program_json['value']);
    if (!$program['ok']) return zeroy_theme_units_wp_error($program);
    $resolved = zeroy_theme_units_resolve_sources($theme_directory, $program['value']);
    if (!$resolved['ok']) return zeroy_theme_units_wp_error($resolved);
    $theme_manifest = zeroy_runtime_theme_runtime_manifest($theme_directory);
    if (is_wp_error($theme_manifest)) return $theme_manifest;
    $compiled = zeroy_theme_units_compile_resolved($program['value'], $resolved['value'], $theme_manifest['zcss']['styles']);
    if (!$compiled['ok']) return zeroy_theme_units_wp_error($compiled);
    zeroy_theme_units_remove_generated_tree($theme_directory);
    foreach ($compiled['value']['outputs'] as $path => $bytes) {
        $target = rtrim($theme_directory, '/') . '/' . $path;
        if (!wp_mkdir_p(dirname($target)) || file_put_contents($target, $bytes, LOCK_EX) !== strlen($bytes)) return zeroy_runtime_error('theme_program_write_failed', 'SiteCheckout compiler could not write a generated ThemeProgram output.', 500, ['path' => $path]);
    }
    return $compiled['value']['manifest'];
}
