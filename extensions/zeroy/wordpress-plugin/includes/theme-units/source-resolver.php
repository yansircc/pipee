<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_read_json_file(string $path, string $field_path): array
{
    if (!is_file($path) || is_link($path)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_file_missing', $field_path, 'ThemeUnit manifest is missing or is not a regular file.', 'Stage the exact manifest and all declared source files.')]];
    try {
        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_json_invalid', $field_path, 'ThemeUnit JSON cannot be decoded: ' . $error->getMessage(), 'Write valid UTF-8 JSON matching themeUnitContract.')]];
    }
    return ['ok' => true, 'value' => $decoded];
}

function zeroy_theme_units_catalog_root(): string
{
    return __DIR__ . '/catalog';
}

function zeroy_theme_units_unit_declared_paths(array $unit): array
{
    $paths = ['unit.json'];
    foreach (($unit['php']['entrypoints'] ?? []) as $path) $paths[] = $path;
    foreach ($unit['styles'] as $path) $paths[] = $path;
    foreach ($unit['scripts'] as $path) $paths[] = $path;
    return array_values(array_unique($paths));
}

function zeroy_theme_units_resolve_directory(string $directory, array $provenance): array
{
    $manifest_result = zeroy_theme_units_read_json_file(rtrim($directory, '/') . '/unit.json', '/unit.json');
    if (!$manifest_result['ok']) return $manifest_result;
    $decoded = zeroy_theme_units_decode_unit($manifest_result['value']);
    if (!$decoded['ok']) return $decoded;
    $unit = $decoded['value'];
    $files = [];
    $total = 0;
    foreach (zeroy_theme_units_unit_declared_paths($unit) as $path) {
        $absolute = rtrim($directory, '/') . '/' . $path;
        if (!is_file($absolute) || is_link($absolute)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_file_missing', '/' . $path, 'ThemeUnit declares a missing or unsafe source file.', 'Stage every declared entrypoint, style and script as a regular file.')]];
        $bytes = $path === 'unit.json' ? zeroy_theme_units_canonical_json(array_filter($unit, static fn(mixed $value): bool => $value !== null)) : file_get_contents($absolute);
        if (!is_string($bytes)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_file_unreadable', '/' . $path, 'ThemeUnit source file cannot be read.', 'Replace the source with a regular readable file.')]];
        $total += strlen($bytes);
        $files[] = ['path' => $path, 'hash' => hash('sha256', $bytes), 'bytes' => $bytes];
    }
    if (count($files) > zeroy_theme_units_policy()['maxFilesPerUnit'] || $total > zeroy_theme_units_policy()['maxSourceBytesPerUnit']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_source_limit', '/', 'ThemeUnit closed source exceeds its file or byte limit.', 'Split or reduce the unit source.')]];
    usort($files, static fn(array $left, array $right): int => strcmp($left['path'], $right['path']));
    $descriptor = array_filter($unit, static fn(mixed $value): bool => $value !== null);
    $source_hash = zeroy_theme_units_hash(['descriptor' => $descriptor, 'files' => array_map(static fn(array $file): array => ['path' => $file['path'], 'hash' => $file['hash']], $files)]);
    return ['ok' => true, 'value' => [
        ...$unit,
        'sourceHash' => $source_hash,
        'files' => $files,
        'provenance' => $provenance,
    ]];
}

function zeroy_theme_units_catalog_entries(): array
{
    $entries = [];
    $root = zeroy_theme_units_catalog_root();
    if (!is_dir($root)) return [];
    foreach (scandir($root) ?: [] as $namespace) {
        if ($namespace === '.' || $namespace === '..' || !is_dir($root . '/' . $namespace)) continue;
        foreach (scandir($root . '/' . $namespace) ?: [] as $name) {
            if ($name === '.' || $name === '..' || !is_dir($root . '/' . $namespace . '/' . $name)) continue;
            $id = $namespace . '/' . $name;
            $resolved = zeroy_theme_units_resolve_directory($root . '/' . $id, ['kind' => 'catalog', 'id' => $id]);
            if (!$resolved['ok'] || $resolved['value']['id'] !== $id) continue;
            $entries[$id] = ['id' => $id, 'integrity' => 'sha256-' . $resolved['value']['sourceHash'], 'directory' => $root . '/' . $id];
        }
    }
    ksort($entries, SORT_STRING);
    return $entries;
}

function zeroy_theme_units_resolve_sources(string $theme_directory, array $program): array
{
    $resolved = [];
    $local_owners = [];
    $catalog = zeroy_theme_units_catalog_entries();
    $total_bytes = 0;
    foreach ($program['units'] as $index => $source) {
        if ($source['kind'] === 'local') {
            $manifest = $source['manifest'];
            $root = dirname($manifest);
            $unit_result = zeroy_theme_units_resolve_directory(rtrim($theme_directory, '/') . '/' . $root, ['kind' => 'local', 'manifest' => $manifest]);
            if (!$unit_result['ok']) return $unit_result;
            foreach ($unit_result['value']['files'] as $file) {
                $theme_path = $root . '/' . $file['path'];
                if (zeroy_runtime_theme_generated_path($theme_path) || isset($local_owners[$theme_path])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_file_owner_duplicate', '/units/' . $index, 'A local source file is generated or owned by more than one unit.', 'Give every unit one disjoint closed source directory.')]];
                $local_owners[$theme_path] = $unit_result['value']['id'];
            }
        } else {
            $entry = $catalog[$source['id']] ?? null;
            if (!is_array($entry)) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_catalog_missing', '/units/' . $index . '/id', 'Catalog unit does not exist in this Connector release.', 'Use an exact catalog reference from themeUnitContract.')]];
            if (!hash_equals($entry['integrity'], $source['integrity'])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_catalog_integrity_mismatch', '/units/' . $index . '/integrity', 'Catalog integrity does not match the selected immutable source.', 'Refresh themeUnitContract and use its exact integrity; never float a catalog reference.')]];
            $unit_result = zeroy_theme_units_resolve_directory($entry['directory'], ['kind' => 'catalog', 'id' => $entry['id'], 'integrity' => $entry['integrity']]);
            if (!$unit_result['ok']) return $unit_result;
        }
        $unit = $unit_result['value'];
        if (isset($resolved[$unit['id']])) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_unit_id_duplicate', '/units/' . $index, 'Two ThemeUnit sources resolve to the same unit ID.', 'Declare each unit ID exactly once.')]];
        foreach ($unit['files'] as $file) $total_bytes += strlen($file['bytes']);
        $resolved[$unit['id']] = $unit;
    }
    if ($total_bytes > zeroy_theme_units_policy()['maxSourceBytes']) return ['ok' => false, 'diagnostics' => [zeroy_theme_units_diagnostic('theme_program_source_limit', '/units', 'ThemeProgram closed source exceeds its total byte limit.', 'Reduce or split the ThemeProgram source graph.')]];
    return ['ok' => true, 'value' => $resolved];
}
