<?php
/**
 * Plugin Name: zeroY Runtime Connector MVP
 * Description: Minimal locale runtime and typed REST connector for Agent-authored WordPress themes.
 * Version: 0.1.0
 */

defined('ABSPATH') || exit;

const ZEROY_MVP_CONTRACT = 'zeroy/theme-schema@1';
const ZEROY_MVP_OPTION_CONFIG = 'zeroy_mvp_site_config';
const ZEROY_MVP_OPTION_KEY = 'zeroy_mvp_connection_key';
const ZEROY_MVP_OPTION_OBJECT = 'zeroy_mvp_canonical_object_id';

function zeroy_mvp_heads_table(): string
{
    global $wpdb;
    return $wpdb->prefix . 'zeroy_mvp_locale_heads';
}

function zeroy_mvp_default_config(): array
{
    return [
        'defaultLocale' => 'zh-CN',
        'enabledLocales' => [
            ['locale' => 'zh-CN', 'label' => '中文', 'urlPrefix' => ''],
            ['locale' => 'en', 'label' => 'English', 'urlPrefix' => 'en'],
        ],
        'revision' => 1,
    ];
}

function zeroy_mvp_site_config(): array
{
    $value = get_option(ZEROY_MVP_OPTION_CONFIG, null);
    if (is_array($value)) {
        return $value;
    }

    $config = zeroy_mvp_default_config();
    add_option(ZEROY_MVP_OPTION_CONFIG, $config, '', false);
    return $config;
}

function zeroy_mvp_connection_key(): string
{
    $key = (string) get_option(ZEROY_MVP_OPTION_KEY, '');
    if ($key !== '') {
        return $key;
    }

    $key = wp_generate_password(32, false, false);
    add_option(ZEROY_MVP_OPTION_KEY, $key, '', false);
    return $key;
}

function zeroy_mvp_locale_config(string $locale): ?array
{
    foreach (zeroy_mvp_site_config()['enabledLocales'] as $candidate) {
        if (($candidate['locale'] ?? null) === $locale) {
            return $candidate;
        }
    }

    return null;
}

function zeroy_mvp_normalize_route(string $route): string|WP_Error
{
    $normalized = trim(wp_normalize_path($route), '/');
    if ($normalized === '' || !preg_match('/\A[a-z0-9][a-z0-9\-\/]*\z/i', $normalized)) {
        return new WP_Error('zeroy_invalid_route', 'Route must contain only path-safe letters, digits, hyphens, and slashes.', ['status' => 400]);
    }

    return strtolower($normalized);
}

function zeroy_mvp_sort_recursive(mixed $value): mixed
{
    if (!is_array($value)) {
        return $value;
    }

    foreach ($value as $key => $child) {
        $value[$key] = zeroy_mvp_sort_recursive($child);
    }
    if (!array_is_list($value)) {
        ksort($value);
    }

    return $value;
}

function zeroy_mvp_schema(): array|WP_Error
{
    $path = get_stylesheet_directory() . '/zeroy.schema.json';
    if (!is_file($path)) {
        return new WP_Error('zeroy_schema_missing', 'The active theme has no zeroy.schema.json.', ['status' => 409]);
    }

    $raw = file_get_contents($path);
    $schema = is_string($raw) ? json_decode($raw, true) : null;
    if (!is_array($schema) || ($schema['contract'] ?? null) !== ZEROY_MVP_CONTRACT || !is_array($schema['schemas'] ?? null)) {
        return new WP_Error('zeroy_schema_invalid', 'zeroy.schema.json is invalid.', ['status' => 409]);
    }

    foreach ($schema['schemas'] as $schema_id => $definition) {
        if (!is_string($schema_id) || !is_array($definition) || !is_string($definition['template'] ?? null) || !is_array($definition['nodes'] ?? null)) {
            return new WP_Error('zeroy_schema_invalid', 'Each zeroY schema requires a template and nodes.', ['status' => 409]);
        }

        $template = $definition['template'];
        if (str_contains($template, '..') || !is_file(get_stylesheet_directory() . '/' . $template)) {
            return new WP_Error('zeroy_template_missing', "Schema {$schema_id} references a missing template.", ['status' => 409]);
        }

        foreach ($definition['nodes'] as $node_id => $node) {
            if (!is_string($node_id) || !is_array($node) || ($node['kind'] ?? null) !== 'text' || !is_bool($node['required'] ?? null)) {
                return new WP_Error('zeroy_schema_invalid', "Schema {$schema_id} has an invalid localized node.", ['status' => 409]);
            }
        }
    }

    return $schema;
}

function zeroy_mvp_schema_definition(string $schema_id): array|WP_Error
{
    $schema = zeroy_mvp_schema();
    if (is_wp_error($schema)) {
        return $schema;
    }

    $definition = $schema['schemas'][$schema_id] ?? null;
    if (!is_array($definition)) {
        return new WP_Error('zeroy_schema_not_found', "Unknown zeroY schema {$schema_id}.", ['status' => 400]);
    }

    return $definition;
}

function zeroy_mvp_schema_hash(array $definition): string
{
    $validators = [];
    foreach ($definition['nodes'] as $node_id => $node) {
        $validators[$node_id] = [
            'kind' => $node['kind'],
            'required' => $node['required'],
            'searchable' => (bool) ($node['searchable'] ?? false),
        ];
    }

    return hash('sha256', wp_json_encode(zeroy_mvp_sort_recursive($validators), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
}

function zeroy_mvp_validate_document(array $document, array $definition, bool $complete): array|WP_Error
{
    $nodes = $definition['nodes'];
    foreach ($document as $node_id => $value) {
        if (!is_string($node_id) || !array_key_exists($node_id, $nodes) || !is_string($value)) {
            return new WP_Error('zeroy_document_invalid', 'Document contains an unknown node or non-text value.', ['status' => 400]);
        }
    }

    if ($complete) {
        foreach ($nodes as $node_id => $node) {
            if (($node['required'] ?? false) && (!isset($document[$node_id]) || trim($document[$node_id]) === '')) {
                return new WP_Error('zeroy_document_incomplete', "Required localized node {$node_id} is missing.", ['status' => 409]);
            }
        }
    }

    return $document;
}

function zeroy_mvp_get_head(int $object_id, string $locale): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare(
            'SELECT * FROM ' . zeroy_mvp_heads_table() . ' WHERE object_id = %d AND locale = %s',
            $object_id,
            $locale
        ),
        ARRAY_A
    );

    return is_array($row) ? $row : null;
}

function zeroy_mvp_get_head_by_route(string $locale, string $route): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare(
            'SELECT * FROM ' . zeroy_mvp_heads_table() . ' WHERE locale = %s AND route_path = %s',
            $locale,
            $route
        ),
        ARRAY_A
    );

    return is_array($row) ? $row : null;
}

function zeroy_mvp_insert_or_update_draft(
    int $object_id,
    string $locale,
    string $schema_id,
    string $route,
    array $document,
    int $expected_revision
): array|WP_Error {
    global $wpdb;

    if (zeroy_mvp_locale_config($locale) === null) {
        return new WP_Error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", ['status' => 400]);
    }
    if (!get_post($object_id)) {
        return new WP_Error('zeroy_object_missing', "Canonical WordPress object {$object_id} does not exist.", ['status' => 404]);
    }

    $route = zeroy_mvp_normalize_route($route);
    if (is_wp_error($route)) {
        return $route;
    }

    $definition = zeroy_mvp_schema_definition($schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $document = zeroy_mvp_validate_document($document, $definition, false);
    if (is_wp_error($document)) {
        return $document;
    }

    $head = zeroy_mvp_get_head($object_id, $locale);
    $current_revision = $head === null ? 0 : (int) $head['revision'];
    if ($current_revision !== $expected_revision) {
        return new WP_Error('zeroy_revision_conflict', 'Locale head revision has changed. Read the current document and retry.', [
            'status' => 409,
            'currentRevision' => $current_revision,
        ]);
    }
    if ($head !== null && $head['schema_id'] !== $schema_id) {
        return new WP_Error('zeroy_schema_assignment_conflict', 'An existing locale head cannot change schema in the MVP.', ['status' => 409]);
    }
    if ($head !== null && $head['published_document'] !== null && $head['route_path'] !== $route) {
        return new WP_Error('zeroy_route_change_deferred', 'Changing a published route is outside the MVP.', ['status' => 409]);
    }

    $next_revision = $current_revision + 1;
    $record = [
        'object_id' => $object_id,
        'locale' => $locale,
        'schema_id' => $schema_id,
        'route_path' => $route,
        'draft_document' => wp_json_encode($document, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        'draft_schema_hash' => zeroy_mvp_schema_hash($definition),
        'revision' => $next_revision,
    ];

    if ($head === null) {
        $written = $wpdb->insert(zeroy_mvp_heads_table(), $record, ['%d', '%s', '%s', '%s', '%s', '%s', '%d']);
    } else {
        $written = $wpdb->update(
            zeroy_mvp_heads_table(),
            $record,
            ['object_id' => $object_id, 'locale' => $locale],
            ['%d', '%s', '%s', '%s', '%s', '%s', '%d'],
            ['%d', '%s']
        );
    }
    if ($written === false) {
        return new WP_Error('zeroy_draft_write_failed', $wpdb->last_error ?: 'Could not save locale draft.', ['status' => 409]);
    }

    flush_rewrite_rules(false);
    return zeroy_mvp_get_head($object_id, $locale);
}

function zeroy_mvp_publish_draft(int $object_id, string $locale, int $expected_revision): array|WP_Error
{
    global $wpdb;

    $head = zeroy_mvp_get_head($object_id, $locale);
    if ($head === null) {
        return new WP_Error('zeroy_head_missing', 'No locale draft exists.', ['status' => 404]);
    }
    if ((int) $head['revision'] !== $expected_revision) {
        return new WP_Error('zeroy_revision_conflict', 'Locale head revision has changed. Read the current document and retry.', [
            'status' => 409,
            'currentRevision' => (int) $head['revision'],
        ]);
    }
    $definition = zeroy_mvp_schema_definition((string) $head['schema_id']);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $document = json_decode((string) $head['draft_document'], true);
    if (!is_array($document)) {
        return new WP_Error('zeroy_draft_missing', 'No valid locale draft exists.', ['status' => 409]);
    }
    $document = zeroy_mvp_validate_document($document, $definition, true);
    if (is_wp_error($document)) {
        return $document;
    }
    $hash = zeroy_mvp_schema_hash($definition);
    if (!hash_equals($hash, (string) $head['draft_schema_hash'])) {
        return new WP_Error('zeroy_schema_changed', 'Theme schema changed after this draft was written. Rewrite the draft first.', ['status' => 409]);
    }

    $next_revision = $expected_revision + 1;
    $written = $wpdb->update(
        zeroy_mvp_heads_table(),
        [
            'published_document' => $head['draft_document'],
            'published_schema_hash' => $hash,
            'revision' => $next_revision,
        ],
        ['object_id' => $object_id, 'locale' => $locale],
        ['%s', '%s', '%d'],
        ['%d', '%s']
    );
    if ($written === false) {
        return new WP_Error('zeroy_publish_failed', $wpdb->last_error ?: 'Could not publish locale draft.', ['status' => 500]);
    }

    if (get_post_status($object_id) !== 'publish') {
        wp_update_post(['ID' => $object_id, 'post_status' => 'publish']);
    }

    flush_rewrite_rules(false);
    return zeroy_mvp_get_head($object_id, $locale);
}

function zeroy_locale_document(int $object_id, string $locale, string $schema_id): array
{
    $head = zeroy_mvp_get_head($object_id, $locale);
    if ($head === null || $head['schema_id'] !== $schema_id || $head['published_document'] === null) {
        wp_die('zeroY locale document is not published.', 'zeroY locale document missing', ['response' => 404]);
    }
    $definition = zeroy_mvp_schema_definition($schema_id);
    if (is_wp_error($definition) || !hash_equals(zeroy_mvp_schema_hash($definition), (string) $head['published_schema_hash'])) {
        wp_die('zeroY locale document does not match the active theme schema.', 'zeroY schema mismatch', ['response' => 404]);
    }
    $document = json_decode((string) $head['published_document'], true);
    if (!is_array($document)) {
        wp_die('zeroY locale document is invalid.', 'zeroY locale document invalid', ['response' => 404]);
    }

    return $document;
}

function zeroy_mvp_route_url(string $locale, string $route): string
{
    $locale_config = zeroy_mvp_locale_config($locale);
    if ($locale_config === null) {
        return home_url('/');
    }
    $prefix = trim((string) $locale_config['urlPrefix'], '/');
    $path = trim(($prefix === '' ? '' : $prefix . '/') . trim($route, '/'), '/');
    return home_url('/' . $path . '/');
}

function zeroy_locale_links(string $route): array
{
    $links = [];
    foreach (zeroy_mvp_site_config()['enabledLocales'] as $locale_config) {
        $locale = (string) $locale_config['locale'];
        $head = zeroy_mvp_get_head_by_route($locale, $route);
        $available = $head !== null && $head['published_document'] !== null;
        $links[] = [
            'locale' => $locale,
            'available' => $available,
            'url' => zeroy_mvp_route_url($locale, $route),
        ];
    }

    return $links;
}

function zeroy_mvp_register_rewrites(): void
{
    global $wpdb;
    $routes = $wpdb->get_results('SELECT DISTINCT locale, route_path FROM ' . zeroy_mvp_heads_table() . ' WHERE route_path IS NOT NULL', ARRAY_A);
    if (!is_array($routes)) {
        return;
    }
    foreach ($routes as $route) {
        $locale = (string) $route['locale'];
        $path = (string) $route['route_path'];
        $locale_config = zeroy_mvp_locale_config($locale);
        if ($locale_config === null || $path === '') {
            continue;
        }
        $prefix = trim((string) $locale_config['urlPrefix'], '/');
        $full_path = trim(($prefix === '' ? '' : $prefix . '/') . $path, '/');
        $regex = '^' . str_replace('/', '\/', preg_quote($full_path, '/')) . '/?$';
        add_rewrite_rule(
            $regex,
            'index.php?zeroy_locale=' . rawurlencode($locale) . '&zeroy_route=' . rawurlencode($path),
            'top'
        );
    }
}
add_action('init', 'zeroy_mvp_register_rewrites', 20);

function zeroy_mvp_query_vars(array $vars): array
{
    $vars[] = 'zeroy_locale';
    $vars[] = 'zeroy_route';
    return $vars;
}
add_filter('query_vars', 'zeroy_mvp_query_vars');

function zeroy_mvp_requested_route(): ?array
{
    $request_uri = $_SERVER['REQUEST_URI'] ?? '';
    $request_path = wp_parse_url($request_uri, PHP_URL_PATH);
    if (!is_string($request_path)) {
        return null;
    }
    $request_path = trim(rawurldecode($request_path), '/');
    if ($request_path === '') {
        return null;
    }

    global $wpdb;
    $routes = $wpdb->get_results(
        'SELECT DISTINCT locale, route_path FROM ' . zeroy_mvp_heads_table() . ' WHERE route_path IS NOT NULL',
        ARRAY_A
    );
    if (!is_array($routes)) {
        return null;
    }
    foreach ($routes as $route) {
        $locale = (string) $route['locale'];
        $locale_config = zeroy_mvp_locale_config($locale);
        if ($locale_config === null) {
            continue;
        }
        $prefix = trim((string) $locale_config['urlPrefix'], '/');
        $expected = trim(($prefix === '' ? '' : $prefix . '/') . (string) $route['route_path'], '/');
        if (hash_equals($expected, $request_path)) {
            return ['locale' => $locale, 'route' => (string) $route['route_path']];
        }
    }

    return null;
}

function zeroy_mvp_disable_wordpress_canonical_redirect($redirect)
{
    if (zeroy_mvp_requested_route() !== null) {
        return false;
    }

    return $redirect;
}
add_filter('redirect_canonical', 'zeroy_mvp_disable_wordpress_canonical_redirect', 1);

function zeroy_mvp_render_route(): void
{
    $requested = zeroy_mvp_requested_route();
    if ($requested === null) {
        return;
    }
    $locale = $requested['locale'];
    $route = $requested['route'];

    $head = zeroy_mvp_get_head_by_route($locale, $route);
    if ($head === null || $head['published_document'] === null) {
        zeroy_mvp_render_404();
    }
    $definition = zeroy_mvp_schema_definition((string) $head['schema_id']);
    if (is_wp_error($definition) || !hash_equals(zeroy_mvp_schema_hash($definition), (string) $head['published_schema_hash'])) {
        zeroy_mvp_render_404();
    }
    $template = get_stylesheet_directory() . '/' . $definition['template'];
    if (!is_file($template)) {
        zeroy_mvp_render_404();
    }

    global $post, $wp_query;
    $wp_query->is_404 = false;
    status_header(200);
    $post = get_post((int) $head['object_id']);
    if (!$post) {
        zeroy_mvp_render_404();
    }
    setup_postdata($post);
    $zeroy_object_id = (int) $head['object_id'];
    $zeroy_locale = $locale;
    $zeroy_schema_id = (string) $head['schema_id'];
    $zeroy_route = $route;
    include $template;
    wp_reset_postdata();
    exit;
}
add_action('template_redirect', 'zeroy_mvp_render_route', 1);

function zeroy_mvp_render_404(): never
{
    global $wp_query;
    $wp_query->set_404();
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

function zeroy_mvp_authorized(WP_REST_Request $request): bool
{
    $provided = (string) $request->get_header('x-zeroy-key');
    return $provided !== '' && hash_equals(zeroy_mvp_connection_key(), $provided);
}

function zeroy_mvp_error_response(WP_Error $error): WP_REST_Response
{
    $data = $error->get_error_data();
    return new WP_REST_Response(
        ['error' => ['code' => $error->get_error_code(), 'message' => $error->get_error_message(), 'data' => $data]],
        is_array($data) && isset($data['status']) ? (int) $data['status'] : 400
    );
}

function zeroy_mvp_inventory(): array
{
    global $wpdb;
    $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_mvp_heads_table() . ' ORDER BY object_id ASC, locale ASC', ARRAY_A);
    $result = [];
    foreach ($heads as $head) {
        $object_id = (int) $head['object_id'];
        if (!isset($result[$object_id])) {
            $result[$object_id] = [
                'objectId' => $object_id,
                'postTitle' => get_the_title($object_id),
                'schemaId' => $head['schema_id'],
                'locales' => [],
            ];
        }
        $result[$object_id]['locales'][] = [
            'locale' => $head['locale'],
            'route' => $head['route_path'],
            'hasDraft' => $head['draft_document'] !== null,
            'published' => $head['published_document'] !== null,
            'revision' => (int) $head['revision'],
        ];
    }

    return array_values($result);
}

function zeroy_mvp_site_endpoint(): WP_REST_Response
{
    $schema = zeroy_mvp_schema();
    if (is_wp_error($schema)) {
        return zeroy_mvp_error_response($schema);
    }
    $schema_hashes = [];
    foreach ($schema['schemas'] as $schema_id => $definition) {
        $schema_hashes[$schema_id] = zeroy_mvp_schema_hash($definition);
    }

    return new WP_REST_Response([
        'contract' => 'zeroy/mvp-site@1',
        'siteId' => 'local-mvp',
        'siteConfig' => zeroy_mvp_site_config(),
        'activeTheme' => wp_get_theme()->get('Name'),
        'contractHash' => hash('sha256', wp_json_encode(zeroy_mvp_sort_recursive($schema), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
        'schema' => $schema,
        'schemaHashes' => $schema_hashes,
        'inventory' => zeroy_mvp_inventory(),
    ]);
}

function zeroy_mvp_theme_file(string $relative): array|WP_Error
{
    $relative = ltrim(wp_normalize_path($relative), '/');
    if ($relative === '' || in_array('..', explode('/', $relative), true)) {
        return new WP_Error('zeroy_theme_path_invalid', 'Theme path escapes the active theme root.', ['status' => 400]);
    }

    $root = realpath(get_stylesheet_directory());
    $candidate = $root === false ? false : $root . '/' . $relative;
    $parent = $candidate === false ? false : realpath(dirname($candidate));
    if ($root === false || $candidate === false || $parent === false || ($parent !== $root && !str_starts_with($parent, $root . DIRECTORY_SEPARATOR))) {
        return new WP_Error('zeroy_theme_path_invalid', 'Theme path escapes the active theme root.', ['status' => 400]);
    }
    if (!is_file($candidate) || is_link($candidate)) {
        return new WP_Error('zeroy_theme_file_missing', 'Only existing regular files in the active theme may be changed in the MVP.', ['status' => 404]);
    }

    return ['root' => $root, 'path' => $candidate, 'relative' => $relative];
}

function zeroy_mvp_theme_file_read(WP_REST_Request $request): WP_REST_Response
{
    $file = zeroy_mvp_theme_file((string) $request->get_param('path'));
    if (is_wp_error($file)) {
        return zeroy_mvp_error_response($file);
    }
    $content = file_get_contents($file['path']);
    if (!is_string($content)) {
        return zeroy_mvp_error_response(new WP_Error('zeroy_theme_file_read_failed', 'Could not read theme file.', ['status' => 500]));
    }

    return new WP_REST_Response([
        'path' => $file['relative'],
        'content' => $content,
        'hash' => hash('sha256', $content),
    ]);
}

function zeroy_mvp_theme_file_write(WP_REST_Request $request): WP_REST_Response
{
    $payload = $request->get_json_params();
    $file = zeroy_mvp_theme_file((string) ($payload['path'] ?? ''));
    if (is_wp_error($file)) {
        return zeroy_mvp_error_response($file);
    }
    $content = $payload['content'] ?? null;
    $expected_hash = $payload['expectedHash'] ?? null;
    if (!is_string($content) || !is_string($expected_hash)) {
        return zeroy_mvp_error_response(new WP_Error('zeroy_theme_write_invalid', 'Theme write requires path, content and expectedHash.', ['status' => 400]));
    }
    $current_hash = hash_file('sha256', $file['path']);
    if (!is_string($current_hash) || !hash_equals($current_hash, $expected_hash)) {
        return zeroy_mvp_error_response(new WP_Error('zeroy_theme_hash_conflict', 'Theme file changed after it was read.', ['status' => 409, 'currentHash' => $current_hash]));
    }

    $temporary = tempnam(dirname($file['path']), '.zeroy-');
    if ($temporary === false || file_put_contents($temporary, $content, LOCK_EX) === false || !rename($temporary, $file['path'])) {
        if (is_string($temporary) && is_file($temporary)) {
            unlink($temporary);
        }
        return zeroy_mvp_error_response(new WP_Error('zeroy_theme_write_failed', 'Could not atomically replace theme file.', ['status' => 500]));
    }

    return new WP_REST_Response([
        'path' => $file['relative'],
        'hash' => hash('sha256', $content),
    ]);
}

function zeroy_mvp_locale_draft_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = $request->get_json_params();
    $result = zeroy_mvp_insert_or_update_draft(
        (int) ($payload['objectId'] ?? 0),
        (string) ($payload['locale'] ?? ''),
        (string) ($payload['schemaId'] ?? ''),
        (string) ($payload['route'] ?? ''),
        is_array($payload['document'] ?? null) ? $payload['document'] : [],
        (int) ($payload['expectedRevision'] ?? -1)
    );
    if (is_wp_error($result)) {
        return zeroy_mvp_error_response($result);
    }

    return new WP_REST_Response([
        'objectId' => (int) $result['object_id'],
        'locale' => $result['locale'],
        'route' => $result['route_path'],
        'revision' => (int) $result['revision'],
        'hasDraft' => true,
    ]);
}

function zeroy_mvp_locale_publish_endpoint(WP_REST_Request $request): WP_REST_Response
{
    $payload = $request->get_json_params();
    $result = zeroy_mvp_publish_draft(
        (int) ($payload['objectId'] ?? 0),
        (string) ($payload['locale'] ?? ''),
        (int) ($payload['expectedRevision'] ?? -1)
    );
    if (is_wp_error($result)) {
        return zeroy_mvp_error_response($result);
    }

    return new WP_REST_Response([
        'objectId' => (int) $result['object_id'],
        'locale' => $result['locale'],
        'route' => $result['route_path'],
        'revision' => (int) $result['revision'],
        'published' => true,
        'url' => zeroy_mvp_route_url((string) $result['locale'], (string) $result['route_path']),
    ]);
}

function zeroy_mvp_register_rest_routes(): void
{
    $args = ['permission_callback' => 'zeroy_mvp_authorized'];
    register_rest_route('zeroy/v1', '/site', $args + [
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'zeroy_mvp_site_endpoint',
    ]);
    register_rest_route('zeroy/v1', '/theme/file', $args + [
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'zeroy_mvp_theme_file_read',
    ]);
    register_rest_route('zeroy/v1', '/theme/file', $args + [
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'zeroy_mvp_theme_file_write',
    ]);
    register_rest_route('zeroy/v1', '/locale/draft', $args + [
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'zeroy_mvp_locale_draft_endpoint',
    ]);
    register_rest_route('zeroy/v1', '/locale/publish', $args + [
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'zeroy_mvp_locale_publish_endpoint',
    ]);
}
add_action('rest_api_init', 'zeroy_mvp_register_rest_routes');

function zeroy_mvp_activate(): void
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset = $wpdb->get_charset_collate();
    $sql = 'CREATE TABLE ' . zeroy_mvp_heads_table() . " (
        object_id BIGINT UNSIGNED NOT NULL,
        locale VARCHAR(32) NOT NULL,
        schema_id VARCHAR(96) NOT NULL,
        route_path VARCHAR(190) NOT NULL,
        draft_document LONGTEXT NULL,
        draft_schema_hash VARCHAR(64) NULL,
        published_document LONGTEXT NULL,
        published_schema_hash VARCHAR(64) NULL,
        revision BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (object_id, locale),
        UNIQUE KEY zeroy_mvp_route (locale, route_path)
    ) {$charset};";
    dbDelta($sql);
    zeroy_mvp_site_config();
    zeroy_mvp_connection_key();

    $object_id = (int) get_option(ZEROY_MVP_OPTION_OBJECT, 0);
    if ($object_id <= 0 || !get_post($object_id)) {
        $object_id = wp_insert_post([
            'post_type' => 'page',
            'post_status' => 'draft',
            'post_title' => 'zeroY MVP canonical object',
        ]);
        if (!is_wp_error($object_id)) {
            update_option(ZEROY_MVP_OPTION_OBJECT, (int) $object_id, false);
            update_post_meta((int) $object_id, '_zeroy_mvp_schema_id', 'showcase');
        }
    }
    if (is_int($object_id) && $object_id > 0 && zeroy_mvp_get_head($object_id, 'zh-CN') === null) {
        $draft = zeroy_mvp_insert_or_update_draft(
            $object_id,
            'zh-CN',
            'showcase',
            'zeroy-mvp',
            [
                'title' => 'Agent 写入的 WordPress 多语言页面',
                'intro' => '这是同一个 WordPress 对象的中文投影。英文版本尚未发布。',
            ],
            0
        );
        if (is_array($draft)) {
            zeroy_mvp_publish_draft($object_id, 'zh-CN', (int) $draft['revision']);
        }
    }
    flush_rewrite_rules(false);
}
register_activation_hook(__FILE__, 'zeroy_mvp_activate');
