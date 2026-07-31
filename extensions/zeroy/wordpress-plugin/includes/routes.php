<?php

defined('ABSPATH') || exit;

function zeroy_runtime_request_path(): string
{
    $path = wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    return is_string($path) ? strtolower(trim(rawurldecode($path), '/')) : '';
}

function zeroy_runtime_route_url(string $locale, string $route): string
{
    $locale_config = zeroy_runtime_locale_config($locale);
    if ($locale_config === null) {
        return home_url('/');
    }
    $path = trim(($locale_config['urlPrefix'] === '' ? '' : $locale_config['urlPrefix'] . '/') . trim($route, '/'), '/');
    return home_url('/' . $path . '/');
}

function zeroy_localization_request_locale_route(): ?array
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return null;
    }
    $path = zeroy_runtime_request_path();
    foreach ($config['enabledLocales'] as $locale) {
        $prefix = $locale['urlPrefix'];
        if ($prefix !== '' && ($path === $prefix || str_starts_with($path, $prefix . '/'))) {
            return ['locale' => $locale['locale'], 'route' => $path === $prefix ? '' : substr($path, strlen($prefix) + 1)];
        }
    }
    return ['locale' => $config['defaultLocale'], 'route' => $path];
}

function zeroy_localization_default_post_for_route(string $route): ?array
{
    $posts = get_posts(['post_type' => get_post_types(['public' => true]), 'post_status' => 'publish', 'posts_per_page' => -1, 'meta_key' => ZEROY_RUNTIME_SCHEMA_META, 'fields' => 'ids']);
    foreach (is_array($posts) ? $posts : [] as $post_id) {
        $canonical = zeroy_runtime_canonical((int) $post_id);
        if (is_wp_error($canonical)) {
            continue;
        }
        $definition = zeroy_runtime_schema_definition($canonical['schemaId']);
        $candidate = is_wp_error($definition) ? $definition : zeroy_localization_subject_route(['kind' => 'post', 'id' => (int) $post_id], $definition);
        if (!is_wp_error($candidate) && $candidate === $route) {
            return ['kind' => 'post', 'id' => (int) $post_id, 'schemaId' => $canonical['schemaId']];
        }
    }
    return null;
}

function zeroy_localization_published_post_for_route(string $locale, string $route): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare(
        'SELECT subject_json, schema_id FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE locale = %s AND route_path = %s AND subject_kind = %s AND published_version_id IS NOT NULL',
        $locale,
        $route,
        'post'
    ), ARRAY_A);
    if (!is_array($row)) {
        return null;
    }
    $subject = zeroy_runtime_decode_json((string) $row['subject_json']);
    return is_wp_error($subject) ? null : ['kind' => 'post', 'id' => (int) ($subject['id'] ?? 0), 'schemaId' => $row['schema_id']];
}

function zeroy_locale_content(int $object_id, string $locale, string $schema_id): array
{
    $resolved = zeroy_localization_post_content($object_id, $locale, $schema_id);
    return is_wp_error($resolved) ? ['post' => [], 'acf' => [], 'templateContent' => [], 'error' => $resolved->get_error_code()] : $resolved;
}

function zeroy_runtime_locale_links_for_post(int $post_id, string $route): array
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return [];
    }
    $post = get_post($post_id);
    $links = [];
    foreach ($config['enabledLocales'] as $locale) {
        $available = $locale['locale'] === $config['defaultLocale']
            ? $post instanceof WP_Post && $post->post_status === 'publish'
            : (($head = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $post_id], $locale['locale'])) !== null && $head['published_version_id'] !== null);
        $links[] = ['locale' => $locale['locale'], 'available' => $available, 'url' => $available ? zeroy_runtime_route_url($locale['locale'], $route) : null];
    }
    return $links;
}

function zeroy_locale_links(string $route): array
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (is_array($context) && ($context['kind'] ?? null) === 'canonical') {
        return zeroy_runtime_locale_links_for_post((int) $context['objectId'], $route);
    }
    $config = zeroy_runtime_site_config();
    return is_wp_error($config) ? [] : array_map(static fn(array $locale): array => ['locale' => $locale['locale'], 'available' => true, 'url' => zeroy_runtime_route_url($locale['locale'], $route)], $config['enabledLocales']);
}

function zeroy_runtime_render_404(): never
{
    global $wp_query;
    if ($wp_query instanceof WP_Query) {
        $wp_query->set_404();
    }
    status_header(404);
    nocache_headers();
    $template = get_query_template('404');
    if ($template !== '') {
        include $template;
    }
    exit;
}

function zeroy_localization_render_post(array $match, string $locale, bool $preview = false): never
{
    $definition = zeroy_runtime_schema_definition((string) $match['schemaId']);
    $content = is_wp_error($definition) ? $definition : zeroy_localization_post_content((int) $match['id'], $locale, (string) $match['schemaId'], $preview ? 'draft_version_id' : 'published_version_id');
    if (is_wp_error($definition) || is_wp_error($content)) {
        zeroy_runtime_render_404();
    }
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template) || is_link($template)) {
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
    $route = zeroy_localization_subject_route(['kind' => 'post', 'id' => (int) $match['id']], $definition);
    $GLOBALS['zeroy_runtime_route_context'] = ['kind' => 'canonical', 'objectId' => (int) $match['id'], 'locale' => $locale, 'schemaId' => $match['schemaId'], 'route' => $route, 'preview' => $preview];
    $zeroy_object_id = (int) $match['id'];
    $zeroy_locale = $locale;
    $zeroy_schema_id = $match['schemaId'];
    $zeroy_route = $route;
    include $template;
    unset($GLOBALS['zeroy_runtime_route_context']);
    exit;
}

function zeroy_runtime_render_collection_route(): void
{
    $request = zeroy_localization_request_locale_route();
    if ($request === null) {
        return;
    }
    $match = zeroy_runtime_collection_for_relative_route($request['route']);
    if ($match === null) {
        return;
    }
    $definition = $match['definition'];
    $term = $match['termSlug'] === null ? null : get_term_by('slug', $match['termSlug'], $definition['taxonomy']);
    if ($match['termSlug'] !== null && !$term instanceof WP_Term) {
        zeroy_runtime_render_404();
    }
    $term_content = $term instanceof WP_Term
        ? zeroy_localization_term_content($term->taxonomy, (int) $term->term_id, $request['locale'])
        : null;
    $title = !is_wp_error($term_content) && is_string($term_content['term']['name'] ?? null)
        ? $term_content['term']['name']
        : ($term instanceof WP_Term ? $term->name : $definition['label']);
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template) || is_link($template)) {
        zeroy_runtime_render_404();
    }
    $route = $definition['route'] . ($match['termSlug'] === null ? '' : '/' . $match['termSlug']);
    set_query_var('paged', (int) ($match['page'] ?? 1));
    $GLOBALS['zeroy_runtime_route_context'] = ['kind' => 'collection', 'collectionId' => $match['collectionId'], 'collectionKind' => $definition['kind'], 'locale' => $request['locale'], 'route' => $route, 'page' => (int) ($match['page'] ?? 1), 'schemaId' => $definition['schemaId'], 'title' => $title, 'term' => $term, 'termContent' => is_array($term_content) ? $term_content : null, 'links' => zeroy_locale_links($route)];
    $zeroy_collection = $GLOBALS['zeroy_runtime_route_context'];
    status_header(200);
    include $template;
    unset($GLOBALS['zeroy_runtime_route_context']);
    exit;
}
add_action('template_redirect', 'zeroy_runtime_render_collection_route', 1);

function zeroy_runtime_render_route(): void
{
    if (isset($_GET['zeroy_translation_preview'])) {
        return;
    }
    $request = zeroy_localization_request_locale_route();
    if ($request === null || zeroy_runtime_collection_for_relative_route($request['route']) !== null) {
        return;
    }
    $config = zeroy_runtime_site_config();
    $match = is_array($config) && $request['locale'] === $config['defaultLocale']
        ? zeroy_localization_default_post_for_route($request['route'])
        : zeroy_localization_published_post_for_route($request['locale'], $request['route']);
    if ($match !== null) {
        zeroy_localization_render_post($match, $request['locale']);
    }
}
add_action('template_redirect', 'zeroy_runtime_render_route', 2);

function zeroy_runtime_render_translation_preview(): void
{
    if (!isset($_GET['zeroy_translation_preview'])) {
        return;
    }
    $subject = zeroy_localization_preview_subject_from_request();
    $locale = isset($_GET['locale']) && is_string($_GET['locale']) ? $_GET['locale'] : '';
    $version_id = isset($_GET['versionId']) ? (int) $_GET['versionId'] : 0;
    $token = isset($_GET['token']) && is_string($_GET['token']) ? $_GET['token'] : '';
    if (is_wp_error($subject) || $subject['kind'] !== 'post' || $version_id < 1 || !hash_equals(hash_hmac('sha256', zeroy_localization_subject_key($subject) . '|' . $locale . '|' . $version_id, zeroy_runtime_connection_key()), $token)) {
        zeroy_runtime_render_404();
    }
    $head = zeroy_localization_overlay_head($subject, $locale);
    if ($head === null || (int) $head['draft_version_id'] !== $version_id) {
        zeroy_runtime_render_404();
    }
    $match = ['kind' => 'post', 'id' => $subject['id'], 'schemaId' => $head['schema_id']];
    zeroy_localization_render_post($match, $locale, true);
}
add_action('template_redirect', 'zeroy_runtime_render_translation_preview', 0);

function zeroy_runtime_localized_title_parts(array $parts): array
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (is_array($context) && ($context['kind'] ?? null) === 'canonical') {
        $content = zeroy_locale_content((int) $context['objectId'], $context['locale'], $context['schemaId']);
        if (is_string($content['post']['title'] ?? null) && $content['post']['title'] !== '') {
            $parts['title'] = $content['post']['title'];
        }
    } elseif (is_array($context) && ($context['kind'] ?? null) === 'collection') {
        $parts['title'] = $context['title'];
    }
    return $parts;
}
add_filter('document_title_parts', 'zeroy_runtime_localized_title_parts');

function zeroy_runtime_emit_seo_links(): void
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (!is_array($context) || ($context['preview'] ?? false)) {
        return;
    }
    $links = ($context['kind'] ?? null) === 'canonical' ? zeroy_runtime_locale_links_for_post((int) $context['objectId'], $context['route']) : ($context['links'] ?? []);
    foreach ($links as $link) {
        if (!$link['available']) {
            continue;
        }
        if ($link['locale'] === $context['locale']) {
            echo '<link rel="canonical" href="' . esc_url($link['url']) . "\" />\n";
        }
        echo '<link rel="alternate" hreflang="' . esc_attr($link['locale']) . '" href="' . esc_url($link['url']) . "\" />\n";
    }
}
add_action('wp_head', 'zeroy_runtime_emit_seo_links', 1);
