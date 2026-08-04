<?php

defined('ABSPATH') || exit;

const ZEROY_PREVIEW_CAPABILITY = 'manage_zeroy_releases';

function zeroy_runtime_register_preview_capability(): void
{
    $administrator = get_role('administrator');
    if ($administrator instanceof WP_Role && !$administrator->has_cap(ZEROY_PREVIEW_CAPABILITY)) {
        $administrator->add_cap(ZEROY_PREVIEW_CAPABILITY);
    }
}

function zeroy_runtime_admin_preview_url(string $release_id, string $route = ''): string
{
    $prefix = '/__zeroy-preview/' . rawurlencode($release_id);
    $suffix = trim($route, '/');
    return home_url($prefix . ($suffix === '' ? '/' : '/' . $suffix . '/'));
}

function zeroy_runtime_preview_release_from_path(): ?array
{
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    if (!is_string($path) || preg_match('#^/__zeroy-preview/([a-f0-9-]{36})(?:/(.*))?/?$#i', rawurldecode($path), $matches) !== 1) return null;
    if (!current_user_can(ZEROY_PREVIEW_CAPABILITY)) {
        status_header(404);
        nocache_headers();
        wp_die('Preview not found.', 'Not found', ['response' => 404]);
    }
    $release = zeroy_runtime_site_release_row(strtolower($matches[1]));
    if ($release === null || !in_array((string) $release['state'], ['preview-awaiting-browser', 'preview', 'proof-ready'], true)) {
        status_header(404);
        nocache_headers();
        wp_die('Preview not found.', 'Not found', ['response' => 404]);
    }
    $route = isset($matches[2]) && is_string($matches[2]) ? trim($matches[2], '/') : '';
    return ['release' => $release, 'route' => $route, 'kind' => 'administrator-preview'];
}

function zeroy_runtime_evidence_release_from_request(): ?array
{
    $release_id = isset($_GET['zeroy_evidence_release']) && is_string($_GET['zeroy_evidence_release']) ? $_GET['zeroy_evidence_release'] : '';
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    if (preg_match('/\A[a-f0-9-]{36}\z/', $release_id) !== 1 || $token === '') return null;
    if (!hash_equals(zeroy_runtime_evidence_access_token($release_id), $token)) return null;
    $release = zeroy_runtime_site_release_row($release_id);
    return $release !== null && in_array((string) $release['state'], ['preview-awaiting-browser', 'preview', 'proof-ready'], true)
        ? ['release' => $release, 'route' => null, 'kind' => 'browser-evidence']
        : null;
}

function zeroy_runtime_preview_release_context(): ?array
{
    $context = $GLOBALS['zeroy_runtime_preview_release_context'] ?? null;
    return is_array($context) ? $context : null;
}
