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
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    $candidates = [];
    foreach (['build', 'release'] as $kind) {
        $key = 'zeroy_candidate_' . $kind;
        if (isset($_GET[$key]) && is_string($_GET[$key]) && $_GET[$key] !== '') $candidates[$kind] = $_GET[$key];
    }
    if (count($candidates) !== 1 || $token === '') return null;
    $kind = array_key_first($candidates);
    $candidate_id = $candidates[$kind];
    if (!hash_equals(hash_hmac('sha256', $kind . ':' . $candidate_id, zeroy_runtime_connection_key()), $token)) return null;
    if ($kind === 'build') return zeroy_build_verification_candidate($candidate_id);
    $release = zeroy_runtime_site_release_row($candidate_id);
    return is_array($release) && in_array($release['state'], ['preparing', 'awaiting-browser', 'prepared'], true) ? $release : null;
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
    $base = content_url('zeroy-runtime/artifacts/' . rawurlencode(str_replace(':', '-', $release['themeArtifactId'])));
    $dependency = [];
    foreach ($projection['stylesheets'] as $index => $path) {
        $handle = $index === 0 ? 'zeroy-zcss-generated' : 'zeroy-theme-style-' . $index;
        wp_enqueue_style($handle, rtrim($base, '/') . '/' . $path, $dependency, $projection['stylesheetHashes'][$path]);
        $dependency = [$handle];
    }
}

function zeroy_runtime_boot_site_release(): void
{
    if (zeroy_runtime_is_connector_safe_request()) return;
    $candidate = zeroy_runtime_candidate_site_release_from_request();
    $active = zeroy_runtime_active_site_release();
    $release = $candidate ?? $active;
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
    $GLOBALS['zeroy_runtime_request_release'] = ['releaseId' => $release['release_id'] ?? null, 'buildId' => $release['build_id'] ?? null, 'themeArtifactId' => $theme_id, 'siteLogicArtifactId' => $logic_id, 'themeDirectory' => $theme_dir, 'siteLogicDirectory' => $logic_dir, 'candidate' => $candidate !== null];
    $GLOBALS['zeroy_runtime_request_snapshot'] = $snapshot;
    $stylesheets = zeroy_runtime_request_stylesheet_projection($theme_dir);
    if (is_wp_error($stylesheets)) wp_die($stylesheets->get_error_message(), 'zeroY release unavailable', ['response' => 503]);
    $GLOBALS['zeroy_runtime_request_stylesheets'] = $stylesheets;
    add_action('wp_enqueue_scripts', 'zeroy_runtime_enqueue_request_stylesheets', PHP_INT_MIN);
    remove_action('wp_head', 'wp_custom_css_cb', 101);
    if (!headers_sent()) header('X-ZeroY-Stylesheet-Identity: ' . $stylesheets['stylesheetSetHash'], true);
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
