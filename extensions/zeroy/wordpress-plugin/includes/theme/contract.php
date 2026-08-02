<?php

defined('ABSPATH') || exit;

const ZEROY_THEME_ARTIFACT_CONTRACT = 'zeroy/theme-artifact@1';
const ZEROY_THEME_MANIFEST_CONTRACT = 'zeroy/theme-manifest@1';
const ZEROY_THEME_POLICY_CONTRACT = 'zeroy/theme-artifact-policy@1';

function zeroy_runtime_theme_required_files(): array
{
    return ['functions.php', 'zeroy.schema.json', 'zeroy.theme.json', 'zcss.design.json', 'assets/css/site.css'];
}

function zeroy_runtime_theme_policy(): array
{
    return [
        'contract' => ZEROY_THEME_POLICY_CONTRACT,
        'forbiddenPaths' => ['.git/**', 'node_modules/**', '.DS_Store', '*.log', '.cache/**', '.tmp/**', 'coverage/**'],
        'maxFiles' => 5000,
        'maxFileBytes' => 16 * 1024 * 1024,
        'maxArtifactBytes' => 256 * 1024 * 1024,
        'maxStorageBytes' => 1024 * 1024 * 1024,
        'allowSymlinks' => false,
    ];
}

function zeroy_runtime_artifact_path_valid(string $path): bool
{
    if ($path === '' || str_contains($path, "\0") || str_starts_with($path, '/') || str_contains($path, '\\')) {
        return false;
    }
    foreach (explode('/', $path) as $segment) {
        if ($segment === '' || $segment === '.' || $segment === '..') {
            return false;
        }
    }
    return true;
}

function zeroy_runtime_artifact_path_forbidden(string $path): bool
{
    return $path === '.DS_Store' ||
        str_ends_with($path, '/.DS_Store') ||
        str_ends_with($path, '.log') ||
        preg_match('#(?:\A|/)(?:\.git|node_modules|\.cache|\.tmp|coverage)(?:/|\z)#', $path) === 1;
}

function zeroy_runtime_normalize_manifest(array $manifest): array|WP_Error
{
    if (($manifest['contract'] ?? null) !== ZEROY_THEME_MANIFEST_CONTRACT || !is_array($manifest['entries'] ?? null) || !array_is_list($manifest['entries'])) {
        return zeroy_runtime_error('zeroy_manifest_invalid', 'Theme manifest must contain a versioned entries list.', 400);
    }
    $policy = zeroy_runtime_theme_policy();
    if (count($manifest['entries']) === 0 || count($manifest['entries']) > $policy['maxFiles']) {
        return zeroy_runtime_error('zeroy_manifest_limit', 'Theme manifest file count is outside the site policy.', 400);
    }
    $entries = [];
    $total = 0;
    foreach ($manifest['entries'] as $entry) {
        $path = is_array($entry) ? ($entry['path'] ?? null) : null;
        $hash = is_array($entry) ? ($entry['hash'] ?? null) : null;
        $bytes = is_array($entry) ? ($entry['bytes'] ?? null) : null;
        $mode = is_array($entry) ? ($entry['mode'] ?? null) : null;
        if (
            !is_string($path) || !zeroy_runtime_artifact_path_valid($path) || zeroy_runtime_artifact_path_forbidden($path) ||
            !is_string($hash) || preg_match('/\A[0-9a-f]{64}\z/', $hash) !== 1 ||
            !is_int($bytes) || $bytes < 0 || $bytes > $policy['maxFileBytes'] ||
            !in_array($mode, ['file', 'executable'], true)
        ) {
            return zeroy_runtime_error('zeroy_manifest_entry_invalid', 'Theme manifest contains an invalid or forbidden file entry.', 400, ['path' => is_string($path) ? $path : null]);
        }
        if (isset($entries[$path])) {
            return zeroy_runtime_error('zeroy_manifest_duplicate_path', 'Theme manifest paths must be unique.', 400, ['path' => $path]);
        }
        $entries[$path] = ['path' => $path, 'hash' => $hash, 'bytes' => $bytes, 'mode' => $mode];
        $total += $bytes;
        if ($total > $policy['maxArtifactBytes']) {
            return zeroy_runtime_error('zeroy_manifest_limit', 'Theme manifest exceeds the site byte limit.', 400);
        }
    }
    ksort($entries, SORT_STRING);
    return ['contract' => ZEROY_THEME_MANIFEST_CONTRACT, 'entries' => array_values($entries)];
}

function zeroy_runtime_manifest_artifact_id(array $manifest): string
{
    return 'sha256:' . hash('sha256', zeroy_runtime_json($manifest));
}
