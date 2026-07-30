<?php

defined('ABSPATH') || exit;

function zeroy_runtime_request_path(): ?string
{
    $request_uri = $_SERVER['REQUEST_URI'] ?? '';
    $path = wp_parse_url($request_uri, PHP_URL_PATH);
    if (!is_string($path)) {
        return null;
    }
    $home_path = wp_parse_url(home_url('/'), PHP_URL_PATH);
    if (is_string($home_path) && $home_path !== '/' && str_starts_with($path, rtrim($home_path, '/') . '/')) {
        $path = substr($path, strlen(rtrim($home_path, '/')));
    }
    $path = trim(rawurldecode($path), '/');
    // An empty request path is FrontPage, represented by the empty stored route.
    // It is resolved only when an explicit root reservation exists.
    return strtolower($path);
}

function zeroy_runtime_reserved_route_for_request(): ?array
{
    static $resolved = false;
    static $reservation = null;
    if ($resolved) {
        return $reservation;
    }
    $resolved = true;
    $request_path = zeroy_runtime_request_path();
    global $wpdb;
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return null;
    }
    $rows = $wpdb->get_results('SELECT locale, route_path, url_prefix, object_id FROM ' . zeroy_runtime_table('route_reservations'), ARRAY_A);
    foreach (is_array($rows) ? $rows : [] as $row) {
        // RouteReservation retains the prefix that made the historic URL visible, so a later
        // locale disablement cannot fall through to an unrelated WordPress page.
        $prefix = (string) $row['url_prefix'];
        $expected = trim(($prefix === '' ? '' : $prefix . '/') . $row['route_path'], '/');
        if ($expected === $request_path) {
            $reservation = [
                'objectId' => (int) $row['object_id'],
                'locale' => (string) $row['locale'],
                'route' => (string) $row['route_path'],
            ];
            return $reservation;
        }
    }
    return null;
}

function zeroy_runtime_disable_canonical_redirect(mixed $redirect): mixed
{
    return zeroy_runtime_reserved_route_for_request() === null ? $redirect : false;
}
add_filter('redirect_canonical', 'zeroy_runtime_disable_canonical_redirect', 1);

function zeroy_runtime_render_404(): never
{
    global $wp_query;
    if ($wp_query instanceof WP_Query) {
        $wp_query->set_404();
    }
    status_header(404);
    nocache_headers();
    $template = get_query_template('404');
    if (is_string($template) && $template !== '') {
        include $template;
    } else {
        wp_die('zeroY locale page is not available.', 'Not found', ['response' => 404]);
    }
    exit;
}

function zeroy_runtime_render_route(): void
{
    $reservation = zeroy_runtime_reserved_route_for_request();
    if ($reservation === null) {
        return;
    }
    $head = zeroy_runtime_get_head($reservation['objectId'], $reservation['locale']);
    if (
        $head === null ||
        $head['route_path'] !== $reservation['route'] ||
        $head['published_version_id'] === null ||
        !zeroy_runtime_locale_is_enabled($reservation['locale'])
    ) {
        zeroy_runtime_render_404();
    }
    $definition = zeroy_runtime_schema_definition((string) $head['schema_id']);
    $document = is_array($definition)
        ? zeroy_runtime_read_document($reservation['objectId'], $reservation['locale'], (string) $head['schema_id'])
        : $definition;
    if (is_wp_error($definition) || is_wp_error($document)) {
        zeroy_runtime_render_404();
    }
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template) || is_link($template)) {
        zeroy_runtime_render_404();
    }
    $post = get_post($reservation['objectId']);
    if (!$post instanceof WP_Post) {
        zeroy_runtime_render_404();
    }

    global $wp_query;
    if ($wp_query instanceof WP_Query) {
        $wp_query->is_404 = false;
    }
    status_header(200);
    $GLOBALS['zeroy_runtime_route_context'] = [
        'objectId' => $reservation['objectId'],
        'locale' => $reservation['locale'],
        'schemaId' => $head['schema_id'],
        'route' => $reservation['route'],
        'publishedVersionId' => (int) $head['published_version_id'],
    ];
    $zeroy_object_id = $reservation['objectId'];
    $zeroy_locale = $reservation['locale'];
    $zeroy_schema_id = $head['schema_id'];
    $zeroy_route = $reservation['route'];
    setup_postdata($post);
    include $template;
    wp_reset_postdata();
    unset($GLOBALS['zeroy_runtime_route_context']);
    exit;
}
add_action('template_redirect', 'zeroy_runtime_render_route', 1);

function zeroy_runtime_emit_seo_links(): void
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (!is_array($context)) {
        return;
    }
    $links = zeroy_runtime_published_locale_links((int) $context['objectId'], (string) $context['schemaId']);
    foreach ($links as $link) {
        if ($link['locale'] === $context['locale']) {
            echo '<link rel="canonical" href="' . esc_url($link['url']) . "\" />\n";
        }
        echo '<link rel="alternate" hreflang="' . esc_attr($link['locale']) . '" href="' . esc_url($link['url']) . "\" />\n";
    }
}
add_action('wp_head', 'zeroy_runtime_emit_seo_links', 1);
