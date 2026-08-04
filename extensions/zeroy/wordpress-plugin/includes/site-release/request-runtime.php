<?php

defined('ABSPATH') || exit;

function zeroy_runtime_is_connector_safe_request(): bool
{
    if ((defined('WP_CLI') && WP_CLI) || (defined('DOING_CRON') && DOING_CRON)) return true;
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    // The SiteRelease owns public rendering only. Login and wp-admin must
    // remain available even before the first ActiveRelease, otherwise an
    // administrator cannot reach the private Preview that replaces it.
    if (is_admin() || (is_string($path) && preg_match('#/(?:wp-login\.php|wp-admin(?:/|$))#', $path) === 1)) return true;
    return (is_string($path) && preg_match('#/wp-json/zeroy(?:/|$)#', $path) === 1) || (isset($_GET['rest_route']) && is_string($_GET['rest_route']) && str_starts_with($_GET['rest_route'], '/zeroy/'));
}

function zeroy_runtime_candidate_site_release_from_request(): ?array
{
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    $build_id = isset($_GET['zeroy_candidate_build']) && is_string($_GET['zeroy_candidate_build']) ? $_GET['zeroy_candidate_build'] : '';
    if ($build_id !== '' && $token !== '' && hash_equals(hash_hmac('sha256', 'build:' . $build_id, zeroy_runtime_connection_key()), $token)) {
        return zeroy_build_verification_candidate($build_id);
    }
    $evidence = zeroy_runtime_evidence_release_from_request();
    return is_array($evidence) && is_array($evidence['release'] ?? null) ? $evidence['release'] : null;
}

function zeroy_runtime_request_site_release(): ?array
{
    $request = $GLOBALS['zeroy_runtime_request_release'] ?? null;
    return is_array($request) ? $request : null;
}

function zeroy_runtime_request_is_candidate_site_release(): bool
{
    $request = zeroy_runtime_request_site_release();
    return is_array($request) && ($request['candidate'] ?? false) === true;
}

function zeroy_runtime_request_snapshot(): array|WP_Error
{
    $snapshot = $GLOBALS['zeroy_runtime_request_snapshot'] ?? null;
    return is_array($snapshot) ? $snapshot : zeroy_runtime_error('zeroy_site_release_snapshot_missing', 'Current request has no SiteSnapshot.', 500);
}

function zeroy_runtime_request_stylesheet_projection(string $theme_directory): array|WP_Error
{
    $manifest = zeroy_runtime_theme_runtime_manifest($theme_directory);
    if (is_wp_error($manifest)) return $manifest;
    $compiled_path = rtrim($theme_directory, '/') . '/' . ZEROY_ZCSS_COMPILED_MANIFEST_PATH;
    $generated_path = rtrim($theme_directory, '/') . '/' . ZEROY_ZCSS_GENERATED_CSS_PATH;
    if (!is_file($compiled_path) || is_link($compiled_path) || !is_file($generated_path) || is_link($generated_path)) {
        return zeroy_runtime_error('zeroy_zcss_output_missing', 'Pinned ThemeArtifact has no complete generated ZCSS output.', 503);
    }
    $compiled = zeroy_runtime_decode_json((string) file_get_contents($compiled_path));
    $generated_hash = hash_file('sha256', $generated_path);
    if (
        is_wp_error($compiled) || ($compiled['contract'] ?? null) !== ZEROY_ZCSS_COMPILED_CONTRACT ||
        ($compiled['compiler']['id'] ?? null) !== ZEROY_ZCSS_COMPILER_ID ||
        !is_string($compiled['outputHash'] ?? null) || !is_string($generated_hash) ||
        !hash_equals($compiled['outputHash'], $generated_hash)
    ) {
        return zeroy_runtime_error('zeroy_zcss_output_invalid', 'Pinned ThemeArtifact ZCSS identity does not match its generated stylesheet bytes.', 503);
    }
    $stylesheet_hashes = [];
    foreach ([ZEROY_ZCSS_GENERATED_CSS_PATH, ...$manifest['zcss']['styles']] as $path) {
        $hash = hash_file('sha256', rtrim($theme_directory, '/') . '/' . $path);
        if (!is_string($hash)) return zeroy_runtime_error('zeroy_zcss_output_invalid', 'Pinned ThemeArtifact has an unreadable stylesheet.', 503, ['path' => $path]);
        $stylesheet_hashes[$path] = $hash;
    }
    return [
        'compiler' => $compiled['compiler'],
        'designHash' => $compiled['designHash'],
        'outputHash' => $compiled['outputHash'],
        'stylesheets' => [ZEROY_ZCSS_GENERATED_CSS_PATH, ...$manifest['zcss']['styles']],
        'stylesheetHashes' => $stylesheet_hashes,
        'stylesheetSetHash' => zeroy_zcss_hash($stylesheet_hashes),
    ];
}

function zeroy_runtime_enqueue_request_stylesheets(): void
{
    $release = zeroy_runtime_request_site_release();
    $projection = $GLOBALS['zeroy_runtime_request_stylesheets'] ?? null;
    if (!is_array($release) || !is_array($projection)) return;
    $base = is_string($release['assetBaseUrl'] ?? null) ? $release['assetBaseUrl'] : '';
    if ($base === '') return;
    $dependency = [];
    foreach ($projection['stylesheets'] as $index => $path) {
        $handle = $index === 0 ? 'zeroy-zcss-generated' : 'zeroy-theme-style-' . $index;
        wp_enqueue_style($handle, rtrim($base, '/') . '/' . $path, $dependency, $projection['stylesheetHashes'][$path]);
        $dependency = [$handle];
    }
}

function zeroy_runtime_boot_site_release(): void
{
    // Assets are not files under wp-content: their bytes are served only after
    // selecting the active, administrator-preview, or verifier release.
    if (zeroy_runtime_serve_theme_asset_request()) return;
    if (zeroy_runtime_is_connector_safe_request()) return;
    $administrator_preview = zeroy_runtime_preview_release_from_path();
    $candidate = $administrator_preview === null ? zeroy_runtime_candidate_site_release_from_request() : null;
    $active = zeroy_runtime_active_site_release();
    $preview = $administrator_preview ?? (is_array($candidate) ? ['release' => $candidate, 'route' => null, 'kind' => 'browser-evidence'] : null);
    $release = is_array($preview['release'] ?? null) ? $preview['release'] : $active;
    if (!is_array($release)) wp_die('No active zeroY SiteRelease is available.', 'zeroY release unavailable', ['response' => 503]);
    $snapshot = zeroy_runtime_site_release_snapshot($release);
    if (is_wp_error($snapshot)) wp_die($snapshot->get_error_message(), 'zeroY release unavailable', ['response' => 503]);
    $theme_id = (string) $release['theme_artifact_id'];
    $logic_id = (string) $release['site_logic_artifact_id'];
    $theme_dir = zeroy_runtime_artifact_directory($theme_id);
    $logic_dir = zeroy_runtime_site_logic_directory($logic_id);
    $functions = $theme_dir . '/functions.php';
    $bootstrap = $logic_dir . '/bootstrap.php';
    if (!is_file($functions) || is_link($functions) || !is_file($bootstrap) || is_link($bootstrap)) wp_die('The selected zeroY SiteRelease is incomplete.', 'zeroY release unavailable', ['response' => 503]);
    $is_preview = is_array($preview);
    if ($is_preview) {
        $GLOBALS['zeroy_runtime_preview_release_context'] = $preview;
        if (is_string($preview['route'] ?? null)) $GLOBALS['zeroy_runtime_preview_route_path'] = $preview['route'];
    }
    $asset_base = zeroy_runtime_theme_asset_base_url_for_request($release);
    if (is_wp_error($asset_base)) wp_die($asset_base->get_error_message(), 'zeroY release unavailable', ['response' => 503]);
    $GLOBALS['zeroy_runtime_request_release'] = ['releaseId' => $release['release_id'] ?? null, 'buildId' => $release['build_id'] ?? null, 'themeArtifactId' => $theme_id, 'siteLogicArtifactId' => $logic_id, 'themeDirectory' => $theme_dir, 'siteLogicDirectory' => $logic_dir, 'assetBaseUrl' => $asset_base, 'candidate' => $is_preview];
    $GLOBALS['zeroy_runtime_request_snapshot'] = $snapshot;
    $stylesheets = zeroy_runtime_request_stylesheet_projection($theme_dir);
    if (is_wp_error($stylesheets)) wp_die($stylesheets->get_error_message(), 'zeroY release unavailable', ['response' => 503]);
    $GLOBALS['zeroy_runtime_request_stylesheets'] = $stylesheets;
    add_action('wp_enqueue_scripts', 'zeroy_runtime_enqueue_request_stylesheets', PHP_INT_MIN);
    remove_action('wp_head', 'wp_custom_css_cb', 101);
    if (!headers_sent()) header('X-ZeroY-Stylesheet-Identity: ' . $stylesheets['stylesheetSetHash'], true);
    foreach (['stylesheet_directory', 'template_directory'] as $filter) add_filter($filter, static fn(): string => $GLOBALS['zeroy_runtime_request_release']['themeDirectory'], PHP_INT_MIN);
    foreach (['stylesheet_directory_uri', 'template_directory_uri'] as $filter) add_filter($filter, static fn(): string => (string) $GLOBALS['zeroy_runtime_request_release']['assetBaseUrl'], PHP_INT_MIN);
    wp_set_template_globals();
    if ($is_preview) {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
        header('Cache-Control: private, no-store, max-age=0', true);
    }
    require $bootstrap;
    require $functions;
}
