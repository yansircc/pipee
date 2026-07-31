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

function zeroy_runtime_reserved_collection_for_request(): ?array
{
    static $resolved = false;
    static $reservation = null;
    if ($resolved) {
        return $reservation;
    }
    $resolved = true;
    $request_path = zeroy_runtime_request_path();
    if ($request_path === null) {
        return null;
    }
    global $wpdb;
    $rows = $wpdb->get_results(
        'SELECT locale, route_path, url_prefix, collection_id, kind FROM ' . zeroy_runtime_table('collection_route_reservations') . ' ORDER BY CHAR_LENGTH(route_path) DESC',
        ARRAY_A
    );
    foreach (is_array($rows) ? $rows : [] as $row) {
        $base = trim(($row['url_prefix'] === '' ? '' : $row['url_prefix'] . '/') . $row['route_path'], '/');
        if ($row['kind'] === 'post-archive' && $request_path === $base) {
            $reservation = [...$row, 'termSlug' => null];
            return $reservation;
        }
        if ($row['kind'] === 'taxonomy' && str_starts_with($request_path, $base . '/')) {
            $term_slug = substr($request_path, strlen($base) + 1);
            if ($term_slug !== '' && !str_contains($term_slug, '/')) {
                $reservation = [...$row, 'termSlug' => $term_slug];
                return $reservation;
            }
        }
    }
    return null;
}

function zeroy_runtime_disable_canonical_redirect(mixed $redirect): mixed
{
    return zeroy_runtime_reserved_route_for_request() === null && zeroy_runtime_reserved_collection_for_request() === null
        ? $redirect
        : false;
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

function zeroy_runtime_render_document(
    array $head,
    array $definition,
    array $document,
    int $version_id,
    bool $preview
): never
{
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template) || is_link($template)) {
        zeroy_runtime_render_404();
    }
    $post = get_post((int) $head['object_id']);
    if (!$post instanceof WP_Post) {
        zeroy_runtime_render_404();
    }

    global $wp_query;
    if ($wp_query instanceof WP_Query) {
        $wp_query->is_404 = false;
    }
    status_header(200);
    if ($preview) {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow, noarchive', true);
    }
    $GLOBALS['zeroy_runtime_route_context'] = [
        'kind' => 'canonical',
        'objectId' => (int) $head['object_id'],
        'locale' => $head['locale'],
        'schemaId' => $head['schema_id'],
        'route' => $head['route_path'],
        'publishedVersionId' => $preview ? null : $version_id,
        'previewVersionId' => $preview ? $version_id : null,
    ];
    if ($preview) {
        $GLOBALS['zeroy_runtime_document_override'] = [
            'objectId' => (int) $head['object_id'],
            'locale' => $head['locale'],
            'schemaId' => $head['schema_id'],
            'document' => $document,
        ];
    }
    $zeroy_object_id = (int) $head['object_id'];
    $zeroy_locale = $head['locale'];
    $zeroy_schema_id = $head['schema_id'];
    $zeroy_route = $head['route_path'];
    $zeroy_preview = $preview;
    setup_postdata($post);
    include $template;
    wp_reset_postdata();
    unset($GLOBALS['zeroy_runtime_document_override']);
    unset($GLOBALS['zeroy_runtime_route_context']);
    exit;
}

function zeroy_runtime_collection_locale_links(array $definition, ?string $term_slug): array
{
    $links = [];
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return [];
    }
    $route = $definition['route'] . ($term_slug === null ? '' : '/' . $term_slug);
    foreach ($config['enabledLocales'] as $locale) {
        $links[] = [
            'locale' => $locale['locale'],
            'available' => true,
            'url' => zeroy_runtime_route_url($locale['locale'], $route),
        ];
    }
    return $links;
}

function zeroy_runtime_collection_title(array $definition, string $locale, ?WP_Term $term): string|WP_Error
{
    if ($term instanceof WP_Term) {
        return $term->name;
    }
    $title_node = $definition['titleNode'] ?? null;
    if (!is_string($title_node)) {
        return (string) $definition['label'];
    }
    $copy = zeroy_runtime_read_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID
    );
    if (is_wp_error($copy)) {
        // Collection identity is available for every enabled locale, including
        // an empty site before ThemeCopy exists. The schema label is its
        // canonical title; optional ThemeCopy only localizes that title.
        return (string) $definition['label'];
    }
    $title = $copy[$title_node] ?? null;
    return is_string($title) && trim($title) !== '' ? $title : (string) $definition['label'];
}

function zeroy_runtime_render_collection_route(): void
{
    $reservation = zeroy_runtime_reserved_collection_for_request();
    if ($reservation === null) {
        return;
    }
    if (!zeroy_runtime_locale_is_enabled((string) $reservation['locale'])) {
        zeroy_runtime_render_404();
    }
    $collections = zeroy_runtime_collection_definitions();
    if (is_wp_error($collections)) {
        zeroy_runtime_render_404();
    }
    $definition = $collections[$reservation['collection_id']] ?? null;
    if (
        !is_array($definition) ||
        $definition['kind'] !== $reservation['kind'] ||
        $definition['route'] !== $reservation['route_path']
    ) {
        // Historic collection reservations never fall through to WordPress.
        zeroy_runtime_render_404();
    }
    $term = null;
    if ($definition['kind'] === 'taxonomy') {
        $term = get_term_by('slug', (string) $reservation['termSlug'], (string) $definition['taxonomy']);
        if (!$term instanceof WP_Term) {
            zeroy_runtime_render_404();
        }
    }
    $title = zeroy_runtime_collection_title($definition, (string) $reservation['locale'], $term);
    if (is_wp_error($title)) {
        zeroy_runtime_render_404();
    }
    $relative_route = $definition['route'] . ($term instanceof WP_Term ? '/' . $term->slug : '');
    $links = zeroy_runtime_collection_locale_links($definition, $term instanceof WP_Term ? $term->slug : null);
    $context = [
        'kind' => 'collection',
        'collectionId' => $reservation['collection_id'],
        'collectionKind' => $definition['kind'],
        'locale' => $reservation['locale'],
        'route' => $relative_route,
        'schemaId' => $definition['schemaId'],
        'title' => $title,
        'term' => $term,
        'links' => $links,
    ];
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template) || is_link($template)) {
        zeroy_runtime_render_404();
    }
    global $wp_query;
    if ($wp_query instanceof WP_Query) {
        $wp_query->is_404 = false;
    }
    status_header(200);
    $GLOBALS['zeroy_runtime_route_context'] = $context;
    $zeroy_collection = $context;
    include $template;
    unset($GLOBALS['zeroy_runtime_route_context']);
    exit;
}
add_action('template_redirect', 'zeroy_runtime_render_collection_route', 1);

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
    zeroy_runtime_render_document($head, $definition, $document, (int) $head['published_version_id'], false);
}
add_action('template_redirect', 'zeroy_runtime_render_route', 1);

function zeroy_runtime_render_preview(): void
{
    if (($_GET['zeroy_preview'] ?? null) !== '1') {
        return;
    }
    $object_id = isset($_GET['objectId']) ? (int) $_GET['objectId'] : 0;
    $locale = isset($_GET['locale']) ? (string) $_GET['locale'] : '';
    $version_id = isset($_GET['versionId']) ? (int) $_GET['versionId'] : 0;
    $token = isset($_GET['token']) ? (string) $_GET['token'] : '';
    if (
        $object_id < 1 ||
        $locale === '' ||
        $version_id < 1 ||
        $token === '' ||
        !hash_equals(zeroy_runtime_preview_token($object_id, $locale, $version_id), $token)
    ) {
        zeroy_runtime_render_404();
    }
    $head = zeroy_runtime_get_head($object_id, $locale);
    if ($head === null || (int) $head['draft_version_id'] !== $version_id || !zeroy_runtime_locale_is_enabled($locale)) {
        zeroy_runtime_render_404();
    }
    $definition = zeroy_runtime_schema_definition((string) $head['schema_id']);
    $version = zeroy_runtime_get_version($version_id);
    $document = $version === null ? zeroy_runtime_error('zeroy_version_missing', 'Draft LocaleVersion is unavailable.', 404) : zeroy_runtime_decode_json((string) $version['document_json']);
    if (is_wp_error($definition) || is_wp_error($document)) {
        zeroy_runtime_render_404();
    }
    $document = zeroy_runtime_resolve_locale_envelope($object_id, $document, $definition, false);
    if (is_wp_error($document)) {
        zeroy_runtime_render_404();
    }
    zeroy_runtime_render_document($head, $definition, $document, $version_id, true);
}
add_action('template_redirect', 'zeroy_runtime_render_preview', 0);

function zeroy_runtime_localized_title_parts(array $parts): array
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (!is_array($context)) {
        return $parts;
    }
    if (($context['kind'] ?? null) === 'collection') {
        $parts['title'] = (string) $context['title'];
        return $parts;
    }
    $content = zeroy_locale_content(
        (int) $context['objectId'],
        (string) $context['locale'],
        (string) $context['schemaId']
    );
    $title = $content['post']['title'] ?? null;
    if (is_string($title) && trim($title) !== '') {
        $parts['title'] = $title;
    }
    return $parts;
}
add_filter('document_title_parts', 'zeroy_runtime_localized_title_parts');

function zeroy_runtime_has_explicit_native_object_reference(): bool
{
    // On WordPress installations without pretty permalinks, get_permalink()
    // produces a URL such as /?page_id=42. Its path is indistinguishable from
    // the zeroY FrontPage path, but its query explicitly addresses a native
    // WordPress object. That object identity, not the incidental path, owns
    // redirect precedence.
    foreach (['p', 'page_id', 'attachment_id'] as $parameter) {
        if (isset($_GET[$parameter]) && filter_var($_GET[$parameter], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) !== false) {
            return true;
        }
    }
    return false;
}

function zeroy_runtime_redirect_native_canonical(): void
{
    if (
        is_admin() ||
        wp_doing_ajax() ||
        is_feed() ||
        is_preview() ||
        (defined('REST_REQUEST') && REST_REQUEST) ||
        !is_singular()
    ) {
        return;
    }
    // A RouteReservation owns a plain path. An explicit native object query is
    // the only exception because it carries stronger object identity and must
    // keep the native permalink redirectable even when its path is `/`.
    if (zeroy_runtime_reserved_route_for_request() !== null && !zeroy_runtime_has_explicit_native_object_reference()) {
        return;
    }
    $post = get_queried_object();
    if (!$post instanceof WP_Post) {
        return;
    }
    $canonical = zeroy_runtime_canonical((int) $post->ID);
    if (is_wp_error($canonical)) {
        return;
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return;
    }
    $locale = (string) $config['defaultLocale'];
    $head = zeroy_runtime_get_head((int) $post->ID, $locale);
    // Adoption alone does not take over the public WordPress URL. The first
    // published default-locale document is the explicit ownership boundary.
    if ($head === null || $head['published_version_id'] === null) {
        return;
    }
    $document = zeroy_runtime_read_document((int) $post->ID, $locale, (string) $head['schema_id']);
    if (is_wp_error($document)) {
        // zeroY owns this public representation already; do not silently fall
        // back to the WordPress permalink after a hard schema cut.
        zeroy_runtime_render_404();
    }
    $target = zeroy_runtime_route_url($locale, (string) $head['route_path']);
    wp_safe_redirect($target, 301, 'zeroY Runtime');
    exit;
}
// Run before route rendering so plain-permalink URLs such as /?page_id=42 do
// not get mistaken for the explicitly reserved FrontPage route.
add_action('template_redirect', 'zeroy_runtime_redirect_native_canonical', 0);

function zeroy_runtime_emit_seo_links(): void
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (!is_array($context) || ($context['previewVersionId'] ?? null) !== null) {
        return;
    }
    $links = ($context['kind'] ?? null) === 'collection'
        ? $context['links']
        : zeroy_runtime_published_locale_links((int) $context['objectId'], (string) $context['schemaId']);
    foreach ($links as $link) {
        if ($link['locale'] === $context['locale']) {
            echo '<link rel="canonical" href="' . esc_url($link['url']) . "\" />\n";
        }
        echo '<link rel="alternate" hreflang="' . esc_attr($link['locale']) . '" href="' . esc_url($link['url']) . "\" />\n";
    }
}
add_action('wp_head', 'zeroy_runtime_emit_seo_links', 1);
