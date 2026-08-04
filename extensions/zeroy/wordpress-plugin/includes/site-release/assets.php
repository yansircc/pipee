<?php

defined('ABSPATH') || exit;

/**
 * Theme bytes have one delivery algebra. A public request may read assets of
 * the exact ActiveRelease; an administrator Preview and a verifier request
 * receive the exact same artifact through their own authorization corridor.
 * No artifact hash is itself an authorization token.
 */
function zeroy_runtime_public_asset_base_url(string $release_id): string
{
    return home_url('/__zeroy-assets/' . rawurlencode($release_id) . '/__assets');
}

function zeroy_runtime_preview_asset_base_url(string $release_id): string
{
    return home_url('/__zeroy-preview/' . rawurlencode($release_id) . '/__assets');
}

function zeroy_runtime_evidence_access_token(string $release_id): string
{
    return hash_hmac('sha256', 'evidence:' . $release_id, zeroy_runtime_connection_key());
}

function zeroy_runtime_evidence_asset_base_url(string $release_id): string
{
    return home_url('/__zeroy-evidence/' . rawurlencode($release_id) . '/' . zeroy_runtime_evidence_access_token($release_id) . '/__assets');
}

function zeroy_runtime_build_asset_base_url(string $build_id): string
{
    $token = hash_hmac('sha256', 'build:' . $build_id, zeroy_runtime_connection_key());
    return home_url('/__zeroy-build/' . rawurlencode(str_replace(':', '-', $build_id)) . '/' . $token . '/__assets');
}

function zeroy_runtime_theme_asset_base_url_for_request(array $release): string|WP_Error
{
    $build_id = isset($_GET['zeroy_candidate_build']) && is_string($_GET['zeroy_candidate_build']) ? $_GET['zeroy_candidate_build'] : '';
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    if ($build_id !== '' && hash_equals(hash_hmac('sha256', 'build:' . $build_id, zeroy_runtime_connection_key()), $token)) {
        return zeroy_runtime_build_asset_base_url($build_id);
    }
    $release_id = is_string($release['release_id'] ?? null) ? $release['release_id'] : '';
    if ($release_id === '') return zeroy_runtime_error('zeroy_asset_release_invalid', 'Theme assets require an exact SiteRelease identity.', 500);
    $context = zeroy_runtime_preview_release_context();
    if (is_array($context) && ($context['kind'] ?? null) === 'administrator-preview') return zeroy_runtime_preview_asset_base_url($release_id);
    if ($release_id !== '' && hash_equals(zeroy_runtime_evidence_access_token($release_id), $token)) {
        return zeroy_runtime_evidence_asset_base_url($release_id);
    }
    return zeroy_runtime_public_asset_base_url($release_id);
}

function zeroy_runtime_normalize_theme_asset_path(string $path): ?string
{
    $path = rawurldecode($path);
    if ($path === '' || str_contains($path, "\0")) return null;
    $segments = [];
    foreach (explode('/', $path) as $segment) {
        if ($segment === '' || $segment === '.') continue;
        if ($segment === '..') {
            if ($segments === []) return null;
            array_pop($segments);
            continue;
        }
        $segments[] = $segment;
    }
    $normalized = implode('/', $segments);
    return str_starts_with($normalized, 'assets/') && zeroy_runtime_artifact_path_valid($normalized) && !zeroy_runtime_artifact_path_forbidden($normalized)
        ? $normalized
        : null;
}

function zeroy_runtime_theme_asset_file(string $artifact_id, string $path): array|WP_Error
{
    $path = zeroy_runtime_normalize_theme_asset_path($path);
    if ($path === null) {
        return zeroy_runtime_error('zeroy_asset_path_invalid', 'Requested ThemeAsset path is not a declared public asset.', 404);
    }
    $artifact = zeroy_runtime_artifact_row($artifact_id);
    $manifest = is_array($artifact) ? zeroy_runtime_decode_json((string) $artifact['manifest_json']) : null;
    $manifest = is_array($manifest) ? zeroy_runtime_normalize_manifest($manifest) : null;
    if (!is_array($manifest)) return zeroy_runtime_error('zeroy_asset_artifact_missing', 'Requested ThemeArtifact does not exist.', 404);
    $entry = null;
    foreach ($manifest['entries'] as $candidate) {
        if (($candidate['path'] ?? null) === $path) {
            $entry = $candidate;
            break;
        }
    }
    if (!is_array($entry)) return zeroy_runtime_error('zeroy_asset_path_missing', 'Requested ThemeAsset is not in the immutable artifact manifest.', 404);
    $root = realpath(zeroy_runtime_artifact_directory($artifact_id));
    $file = $root === false ? false : realpath($root . '/' . $path);
    if (!is_string($root) || !is_string($file) || !str_starts_with($file, rtrim($root, '/') . '/') || !is_file($file) || is_link($file)) {
        return zeroy_runtime_error('zeroy_asset_path_missing', 'Requested ThemeAsset is unavailable.', 404);
    }
    $hash = hash_file('sha256', $file);
    if (!is_string($hash) || !hash_equals((string) $entry['hash'], $hash)) {
        return zeroy_runtime_error('zeroy_asset_integrity_failed', 'Requested ThemeAsset no longer matches its immutable manifest.', 503);
    }
    return ['path' => $path, 'file' => $file, 'hash' => $hash];
}

function zeroy_runtime_asset_not_found(): never
{
    status_header(404);
    nocache_headers();
    exit;
}

function zeroy_runtime_send_theme_asset(string $artifact_id, string $path, bool $private): never
{
    $asset = zeroy_runtime_theme_asset_file($artifact_id, $path);
    if (is_wp_error($asset)) zeroy_runtime_asset_not_found();
    $type = wp_check_filetype((string) $asset['path'])['type'] ?? '';
    status_header(200);
    header('Content-Type: ' . ($type === '' ? 'application/octet-stream' : $type), true);
    header('Content-Length: ' . (string) filesize((string) $asset['file']), true);
    header('X-Content-Type-Options: nosniff', true);
    header('ETag: "' . $asset['hash'] . '"', true);
    header($private ? 'Cache-Control: private, no-store, max-age=0' : 'Cache-Control: public, max-age=31536000, immutable', true);
    readfile((string) $asset['file']);
    exit;
}

function zeroy_runtime_asset_request(): ?array
{
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    if (!is_string($path)) return null;
    $path = rawurldecode($path);
    if (preg_match('#^/__zeroy-preview/([a-f0-9-]{36})/__assets/(.+)$#i', $path, $matches) === 1) {
        return ['kind' => 'preview', 'releaseId' => strtolower($matches[1]), 'path' => $matches[2]];
    }
    if (preg_match('#^/__zeroy-evidence/([a-f0-9-]{36})/([a-f0-9]{64})/__assets/(.+)$#i', $path, $matches) === 1) {
        return ['kind' => 'evidence', 'releaseId' => strtolower($matches[1]), 'token' => strtolower($matches[2]), 'path' => $matches[3]];
    }
    if (preg_match('#^/__zeroy-build/sha256-([a-f0-9]{64})/([a-f0-9]{64})/__assets/(.+)$#i', $path, $matches) === 1) {
        return ['kind' => 'build', 'buildId' => 'sha256:' . strtolower($matches[1]), 'token' => strtolower($matches[2]), 'path' => $matches[3]];
    }
    if (preg_match('#^/__zeroy-assets/([a-f0-9-]{36})/__assets/(.+)$#i', $path, $matches) === 1) {
        return ['kind' => 'active', 'releaseId' => strtolower($matches[1]), 'path' => $matches[2]];
    }
    return null;
}

/** Returns true only when this request was consumed by the asset boundary. */
function zeroy_runtime_serve_theme_asset_request(): bool
{
    $request = zeroy_runtime_asset_request();
    if ($request === null) return false;
    $release = null;
    $private = false;
    if ($request['kind'] === 'preview') {
        if (!current_user_can(ZEROY_PREVIEW_CAPABILITY)) zeroy_runtime_asset_not_found();
        $release = zeroy_runtime_site_release_row((string) $request['releaseId']);
        $private = true;
    } elseif ($request['kind'] === 'evidence') {
        if (!hash_equals(zeroy_runtime_evidence_access_token((string) $request['releaseId']), (string) $request['token'])) zeroy_runtime_asset_not_found();
        $release = zeroy_runtime_site_release_row((string) $request['releaseId']);
        $private = true;
    } elseif ($request['kind'] === 'build') {
        $build_id = (string) $request['buildId'];
        if (!hash_equals(hash_hmac('sha256', 'build:' . $build_id, zeroy_runtime_connection_key()), (string) $request['token'])) zeroy_runtime_asset_not_found();
        $candidate = zeroy_build_verification_candidate($build_id);
        $artifact_id = is_array($candidate) && is_array($candidate['artifacts']['theme'] ?? null) ? ($candidate['artifacts']['theme']['artifactId'] ?? null) : null;
        if (!is_string($artifact_id)) zeroy_runtime_asset_not_found();
        zeroy_runtime_send_theme_asset($artifact_id, (string) $request['path'], true);
    } else {
        $release = zeroy_runtime_active_site_release();
        if (!is_array($release) || !hash_equals((string) $release['release_id'], (string) $request['releaseId'])) zeroy_runtime_asset_not_found();
    }
    if (!is_array($release) || !in_array((string) $release['state'], ['active', 'preview-awaiting-browser', 'preview', 'proof-ready'], true)) zeroy_runtime_asset_not_found();
    zeroy_runtime_send_theme_asset((string) $release['theme_artifact_id'], (string) $request['path'], $private);
}
