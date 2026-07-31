<?php

defined('ABSPATH') || exit;

function zeroy_runtime_is_connector_safe_request(): bool
{
    if ((defined('WP_CLI') && WP_CLI) || (defined('DOING_CRON') && DOING_CRON)) {
        return true;
    }
    $request_uri = (string) ($_SERVER['REQUEST_URI'] ?? '');
    $path = wp_parse_url($request_uri, PHP_URL_PATH);
    if (is_string($path) && preg_match('#/wp-json/zeroy(?:/|\z)#', $path) === 1) {
        return true;
    }
    return isset($_GET['rest_route']) && is_string($_GET['rest_route']) && str_starts_with($_GET['rest_route'], '/zeroy/');
}

function zeroy_runtime_candidate_deployment_from_request(): ?array
{
    $deployment_id = isset($_GET['zeroy_candidate']) && is_string($_GET['zeroy_candidate']) ? $_GET['zeroy_candidate'] : '';
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    if ($deployment_id === '' || $token === '' || !hash_equals(hash_hmac('sha256', $deployment_id, zeroy_runtime_connection_key()), $token)) {
        return null;
    }
    $deployment = zeroy_runtime_deployment_row($deployment_id);
    return is_array($deployment) && $deployment['state'] === 'prepared' ? $deployment : null;
}

function zeroy_runtime_is_candidate_artifact_request(): bool
{
    $request = $GLOBALS['zeroy_runtime_request_artifact'] ?? null;
    return is_array($request) && ($request['candidate'] ?? false) === true;
}

function zeroy_runtime_boot_theme_artifact(): void
{
    if (zeroy_runtime_is_connector_safe_request()) {
        return;
    }
    $candidate = zeroy_runtime_candidate_deployment_from_request();
    $active = zeroy_runtime_active_theme_state();
    $artifact_id = is_array($candidate) ? (string) $candidate['artifact_id'] : (is_array($active) ? (string) $active['artifact_id'] : '');
    if ($artifact_id === '') {
        wp_die('No active zeroY ThemeArtifact is available.', 'zeroY artifact unavailable', ['response' => 503]);
    }
    $directory = zeroy_runtime_artifact_directory($artifact_id);
    $functions = $directory . '/functions.php';
    if (!is_dir($directory) || !is_file($functions) || is_link($functions)) {
        wp_die('The selected zeroY ThemeArtifact is incomplete.', 'zeroY artifact unavailable', ['response' => 503]);
    }
    $GLOBALS['zeroy_runtime_request_artifact'] = [
        'artifactId' => $artifact_id,
        'deploymentId' => is_array($candidate) ? $candidate['deployment_id'] : $active['active_deployment_id'],
        'directory' => $directory,
        'uri' => zeroy_runtime_artifact_uri($artifact_id),
        'candidate' => is_array($candidate),
    ];
    foreach (['stylesheet_directory', 'template_directory'] as $filter) {
        add_filter($filter, static fn(): string => $GLOBALS['zeroy_runtime_request_artifact']['directory'], PHP_INT_MIN);
    }
    foreach (['stylesheet_directory_uri', 'template_directory_uri'] as $filter) {
        add_filter($filter, static fn(): string => $GLOBALS['zeroy_runtime_request_artifact']['uri'], PHP_INT_MIN);
    }
    wp_set_template_globals();
    if (is_array($candidate)) {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
    }
    require $functions;
}
