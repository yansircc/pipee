<?php

defined('ABSPATH') || exit;

function zeroy_runtime_is_connector_safe_request(): bool
{
    if ((defined('WP_CLI') && WP_CLI) || (defined('DOING_CRON') && DOING_CRON)) return true;
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    return (is_string($path) && preg_match('#/wp-json/zeroy(?:/|$)#', $path) === 1) || (isset($_GET['rest_route']) && is_string($_GET['rest_route']) && str_starts_with($_GET['rest_route'], '/zeroy/'));
}

function zeroy_runtime_candidate_site_release_from_request(): ?array
{
    $release_id = isset($_GET['zeroy_candidate_release']) && is_string($_GET['zeroy_candidate_release']) ? $_GET['zeroy_candidate_release'] : '';
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    if ($release_id === '' || $token === '' || !hash_equals(hash_hmac('sha256', $release_id, zeroy_runtime_connection_key()), $token)) return null;
    $release = zeroy_runtime_site_release_row($release_id);
    return is_array($release) && in_array($release['state'], ['preparing', 'prepared'], true) ? $release : null;
}

function zeroy_runtime_request_site_release(): ?array
{
    $request = $GLOBALS['zeroy_runtime_request_release'] ?? null;
    return is_array($request) ? $request : null;
}

function zeroy_runtime_boot_site_release(): void
{
    if (zeroy_runtime_is_connector_safe_request()) return;
    $candidate = zeroy_runtime_candidate_site_release_from_request();
    $active = zeroy_runtime_active_site_release();
    $release = $candidate ?? $active;
    if (!is_array($release)) wp_die('No active zeroY SiteRelease is available.', 'zeroY release unavailable', ['response' => 503]);
    $theme_id = (string) $release['theme_artifact_id'];
    $logic_id = (string) $release['site_logic_artifact_id'];
    $theme_dir = zeroy_runtime_artifact_directory($theme_id);
    $logic_dir = zeroy_runtime_site_logic_directory($logic_id);
    $functions = $theme_dir . '/functions.php';
    $bootstrap = $logic_dir . '/bootstrap.php';
    if (!is_file($functions) || is_link($functions) || !is_file($bootstrap) || is_link($bootstrap)) wp_die('The selected zeroY SiteRelease is incomplete.', 'zeroY release unavailable', ['response' => 503]);
    $GLOBALS['zeroy_runtime_request_release'] = ['releaseId' => $release['release_id'], 'themeArtifactId' => $theme_id, 'siteLogicArtifactId' => $logic_id, 'themeDirectory' => $theme_dir, 'siteLogicDirectory' => $logic_dir, 'candidate' => $candidate !== null];
    foreach (['stylesheet_directory', 'template_directory'] as $filter) add_filter($filter, static fn(): string => $GLOBALS['zeroy_runtime_request_release']['themeDirectory'], PHP_INT_MIN);
    foreach (['stylesheet_directory_uri', 'template_directory_uri'] as $filter) add_filter($filter, static fn(): string => content_url('zeroy-runtime/artifacts/' . rawurlencode(str_replace(':', '-', $GLOBALS['zeroy_runtime_request_release']['themeArtifactId']))), PHP_INT_MIN);
    wp_set_template_globals();
    if ($candidate !== null) {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
    }
    require $bootstrap;
    require $functions;
}
