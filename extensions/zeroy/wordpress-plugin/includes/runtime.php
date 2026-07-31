<?php

defined('ABSPATH') || exit;

function zeroy_runtime_table(string $name): string
{
    global $wpdb;
    return $wpdb->prefix . 'zeroy_runtime_' . $name;
}

function zeroy_runtime_error(string $code, string $message, int $status = 400, array $extra = []): WP_Error
{
    return new WP_Error($code, $message, ['status' => $status] + $extra);
}

function zeroy_runtime_json(mixed $value): string
{
    return (string) wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function zeroy_runtime_decode_json(string $json): array|WP_Error
{
    $decoded = json_decode($json, true);
    if (!is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
        return zeroy_runtime_error('zeroy_invalid_json', 'Expected a JSON object.', 400);
    }
    return $decoded;
}

function zeroy_runtime_sort_recursive(mixed $value): mixed
{
    if (!is_array($value)) {
        return $value;
    }

    foreach ($value as $key => $child) {
        $value[$key] = zeroy_runtime_sort_recursive($child);
    }
    if (!array_is_list($value)) {
        ksort($value, SORT_STRING);
    }
    return $value;
}

function zeroy_runtime_hash(mixed $value): string
{
    return hash('sha256', zeroy_runtime_json(zeroy_runtime_sort_recursive($value)));
}

function zeroy_runtime_site_id(): string
{
    $site_id = (string) get_option(ZEROY_RUNTIME_SITE_ID_OPTION, '');
    if ($site_id !== '') {
        return $site_id;
    }

    $site_id = wp_generate_uuid4();
    add_option(ZEROY_RUNTIME_SITE_ID_OPTION, $site_id, '', false);
    return $site_id;
}

function zeroy_runtime_connection_key(): string
{
    $key = (string) get_option(ZEROY_RUNTIME_CONNECTION_KEY_OPTION, '');
    if ($key !== '') {
        return $key;
    }

    $key = wp_generate_password(32, false, false);
    add_option(ZEROY_RUNTIME_CONNECTION_KEY_OPTION, $key, '', false);
    return $key;
}

function zeroy_runtime_default_site_config(): array
{
    return [
        'defaultLocale' => 'zh-CN',
        'enabledLocales' => [
            ['locale' => 'zh-CN', 'label' => '中文', 'urlPrefix' => ''],
            ['locale' => 'en', 'label' => 'English', 'urlPrefix' => 'en'],
        ],
    ];
}

function zeroy_runtime_content_ownership(): array
{
    return [
        'contract' => 'zeroy/content-ownership@1',
        'canonical' => [
            'owner' => 'wordpress',
            'facts' => ['post fields', 'ACF values'],
            'rule' => 'zeroY never copies, translates, or overwrites canonical WordPress or ACF facts.',
        ],
        'localizedDocuments' => [
            'owner' => 'zeroy-locale-store',
            'facts' => ['ThemeSchema-declared localized nodes', 'explicit inherit/override decisions for every effective WordPress/ACF leaf', 'locale routes', 'draft and published version pointers'],
            'rule' => 'zeroY stores decisions, never translated copies in canonical WordPress/ACF fields. Theme PHP reads the resolved projection through zeroy_locale_content.',
        ],
        'themeCopy' => [
            'owner' => 'zeroy-locale-store',
            'facts' => ['themeCopy.nodes declared by the active ThemeSchema'],
            'rule' => 'Theme PHP reads these values explicitly through zeroy_theme_copy_document.',
        ],
        'adoption' => [
            'mode' => 'identity-only',
            'precondition' => 'expectedSourceHash from existingPost',
            'rule' => 'Adoption attaches zeroY canonical identity without migrating existing WordPress or ACF values.',
        ],
    ];
}

function zeroy_runtime_normalize_locale(string $locale): string|WP_Error
{
    $locale = trim($locale);
    if (!preg_match('/\A[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\z/', $locale)) {
        return zeroy_runtime_error('zeroy_invalid_locale', 'Locale must be a BCP-47-like identifier.', 400);
    }
    return $locale;
}

function zeroy_runtime_normalize_route(string $route): string|WP_Error
{
    $route = trim(rawurldecode($route));
    if (str_contains($route, "\0")) {
        return zeroy_runtime_error('zeroy_invalid_route', 'Route contains a null byte.', 400);
    }
    $front_page = $route === '/';
    $route = trim(wp_normalize_path($route), '/');
    if ($route === '') {
        // The empty stored path is the one explicit representation of FrontPage.
        // It is never inferred from an arbitrary missing route.
        return $front_page
            ? ''
            : zeroy_runtime_error('zeroy_invalid_route', 'Route must be / for the front page or a non-empty path using letters, digits, underscores, hyphens, and slashes.', 400);
    }
    if (!preg_match('/\A[a-z0-9][a-z0-9_\-\/]*\z/i', $route)) {
        return zeroy_runtime_error('zeroy_invalid_route', 'Route must be / for the front page or a non-empty path using letters, digits, underscores, hyphens, and slashes.', 400);
    }
    return strtolower($route);
}

function zeroy_runtime_validate_site_config(array $input): array|WP_Error
{
    $default = zeroy_runtime_normalize_locale((string) ($input['defaultLocale'] ?? ''));
    if (is_wp_error($default)) {
        return $default;
    }
    $raw_locales = $input['enabledLocales'] ?? null;
    if (!is_array($raw_locales) || !array_is_list($raw_locales) || count($raw_locales) === 0) {
        return zeroy_runtime_error('zeroy_invalid_site_config', 'enabledLocales must be a non-empty list.', 400);
    }

    $seen_locale = [];
    $seen_prefix = [];
    $locales = [];
    foreach ($raw_locales as $candidate) {
        if (!is_array($candidate)) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Each enabled locale must be an object.', 400);
        }
        $locale = zeroy_runtime_normalize_locale((string) ($candidate['locale'] ?? ''));
        if (is_wp_error($locale)) {
            return $locale;
        }
        $label = trim((string) ($candidate['label'] ?? ''));
        $prefix = trim(wp_normalize_path((string) ($candidate['urlPrefix'] ?? '')), '/');
        if ($label === '' || strlen($label) > 80) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Every locale needs a short label.', 400);
        }
        if ($prefix !== '' && !preg_match('/\A[a-z0-9][a-z0-9\-]*\z/i', $prefix)) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Locale URL prefixes must be one path-safe segment.', 400);
        }
        if (isset($seen_locale[$locale]) || isset($seen_prefix[$prefix])) {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'Locale identifiers and URL prefixes must be unique.', 400);
        }
        $seen_locale[$locale] = true;
        $seen_prefix[$prefix] = true;
        $locales[] = ['locale' => $locale, 'label' => $label, 'urlPrefix' => strtolower($prefix)];
    }

    if (!isset($seen_locale[$default])) {
        return zeroy_runtime_error('zeroy_invalid_site_config', 'defaultLocale must be enabled.', 400);
    }
    foreach ($locales as $locale) {
        if ($locale['locale'] === $default && $locale['urlPrefix'] !== '') {
            return zeroy_runtime_error('zeroy_invalid_site_config', 'The default locale must use an empty URL prefix.', 400);
        }
    }
    return ['defaultLocale' => $default, 'enabledLocales' => $locales];
}

function zeroy_runtime_ensure_site_config(): void
{
    global $wpdb;
    $table = zeroy_runtime_table('site_config');
    $existing = $wpdb->get_var("SELECT singleton FROM {$table} WHERE singleton = 1");
    if ($existing !== null) {
        return;
    }
    $wpdb->insert(
        $table,
        ['singleton' => 1, 'config_json' => zeroy_runtime_json(zeroy_runtime_default_site_config()), 'revision' => 1],
        ['%d', '%s', '%d']
    );
}

function zeroy_runtime_site_config(): array|WP_Error
{
    global $wpdb;
    zeroy_runtime_ensure_site_config();
    $row = $wpdb->get_row('SELECT config_json, revision FROM ' . zeroy_runtime_table('site_config') . ' WHERE singleton = 1', ARRAY_A);
    if (!is_array($row)) {
        return zeroy_runtime_error('zeroy_site_config_missing', 'SiteConfig is unavailable.', 500);
    }
    $config = zeroy_runtime_decode_json((string) $row['config_json']);
    if (is_wp_error($config)) {
        return zeroy_runtime_error('zeroy_site_config_invalid', 'Stored SiteConfig is invalid.', 409);
    }
    $config = zeroy_runtime_validate_site_config($config);
    if (is_wp_error($config)) {
        return zeroy_runtime_error('zeroy_site_config_invalid', 'Stored SiteConfig is invalid.', 409);
    }
    $config['revision'] = (int) $row['revision'];
    return $config;
}

function zeroy_runtime_has_published_documents(): bool
{
    global $wpdb;
    return (int) $wpdb->get_var('SELECT COUNT(*) FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE published_version_id IS NOT NULL') > 0;
}

function zeroy_runtime_update_site_config(array $input, int $expected_revision): array|WP_Error
{
    $result = zeroy_runtime_transaction(function () use ($input, $expected_revision) {
        $lease = zeroy_runtime_acquire_schema_lease();
        return is_wp_error($lease)
            ? $lease
            : zeroy_runtime_update_site_config_locked($input, $expected_revision);
    });
    if (!is_wp_error($result)) {
        flush_rewrite_rules(false);
    }
    return $result;
}

function zeroy_runtime_update_site_config_locked(array $input, int $expected_revision): array|WP_Error
{
    global $wpdb;
    $next = zeroy_runtime_validate_site_config($input);
    if (is_wp_error($next)) {
        return $next;
    }
    $current = zeroy_runtime_site_config();
    if (is_wp_error($current)) {
        return $current;
    }
    if ($current['revision'] !== $expected_revision) {
        return zeroy_runtime_error('zeroy_site_config_conflict', 'SiteConfig changed after it was read.', 409, ['currentRevision' => $current['revision']]);
    }
    if ($current['defaultLocale'] !== $next['defaultLocale'] && zeroy_runtime_has_published_documents()) {
        return zeroy_runtime_error('zeroy_default_locale_locked', 'The default locale is locked after the first publish.', 409);
    }
    $next_prefixes = [];
    foreach ($next['enabledLocales'] as $locale) {
        $next_prefixes[$locale['locale']] = $locale['urlPrefix'];
    }
    foreach ($current['enabledLocales'] as $locale) {
        $locale_id = $locale['locale'];
        // A reservation makes an existing locale prefix immutable, but it must not
        // prevent disabling that locale. RouteReservation owns the historical URL
        // snapshot and routes it to a 404 while the locale is disabled.
        if (isset($next_prefixes[$locale_id]) && $next_prefixes[$locale_id] !== $locale['urlPrefix']) {
            $reserved = (int) $wpdb->get_var(
                $wpdb->prepare('SELECT COUNT(*) FROM ' . zeroy_runtime_table('route_reservations') . ' WHERE locale = %s', $locale_id)
            );
            $reserved += (int) $wpdb->get_var(
                $wpdb->prepare('SELECT COUNT(*) FROM ' . zeroy_runtime_table('collection_route_reservations') . ' WHERE locale = %s', $locale_id)
            );
            if ($reserved > 0) {
                return zeroy_runtime_error('zeroy_locale_prefix_locked', 'A locale URL prefix is locked after its first route reservation.', 409);
            }
        }
    }
    $next_revision = $expected_revision + 1;
    $updated = $wpdb->query(
        $wpdb->prepare(
            'UPDATE ' . zeroy_runtime_table('site_config') . ' SET config_json = %s, revision = %d WHERE singleton = 1 AND revision = %d',
            zeroy_runtime_json($next),
            $next_revision,
            $expected_revision
        )
    );
    if ($updated !== 1) {
        $fresh = zeroy_runtime_site_config();
        return zeroy_runtime_error('zeroy_site_config_conflict', 'SiteConfig changed after it was read.', 409, [
            'currentRevision' => is_array($fresh) ? $fresh['revision'] : null,
        ]);
    }
    $next['revision'] = $next_revision;
    $schema = zeroy_runtime_theme_schema();
    if (is_array($schema)) {
        $reservations = zeroy_runtime_sync_collection_route_reservations($schema);
        if (count($reservations['conflicts']) > 0) {
            return zeroy_runtime_error(
                'zeroy_collection_route_conflict',
                'SiteConfig would make a CollectionRoute conflict with an existing route owner.',
                409,
                ['routeConflicts' => $reservations['conflicts']]
            );
        }
    }
    return $next;
}

function zeroy_runtime_locale_config(string $locale): ?array
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return null;
    }
    foreach ($config['enabledLocales'] as $candidate) {
        if ($candidate['locale'] === $locale) {
            return $candidate;
        }
    }
    return null;
}

function zeroy_runtime_locale_is_enabled(string $locale): bool
{
    return zeroy_runtime_locale_config($locale) !== null;
}

function zeroy_runtime_node_kind_contracts(): array
{
    return [
        'text' => [
            'kind' => 'text',
            'valueType' => 'string',
            'requiredProperties' => ['required' => 'boolean', 'searchable' => 'boolean'],
            'description' => 'Plain localized text. The theme escapes it with esc_html.',
        ],
        'rich-text' => [
            'kind' => 'rich-text',
            'valueType' => 'string',
            'requiredProperties' => ['required' => 'boolean', 'searchable' => 'boolean'],
            'description' => 'Localized rich text. The theme renders it with its explicit HTML policy.',
        ],
    ];
}

function zeroy_runtime_theme_schema_capabilities(): array
{
    return [
        'contract' => 'zeroy/theme-schema-language@1',
        'nodeIdPattern' => '^[a-z][a-z0-9_]*(?:\\.(?:[a-z][a-z0-9_]*|\\*))*$',
        'nodeKinds' => array_values(zeroy_runtime_node_kind_contracts()),
        'themeCopy' => [
            'declaration' => 'Optional top-level themeCopy.nodes using the same node language.',
            'ownership' => 'zeroY LocaleStore owns localized theme copy; WordPress and ACF canonical facts are never copied into it.',
        ],
        'collections' => [
            'declaration' => 'Optional top-level keyed collections object. Each declaration owns one locale-aware post archive or taxonomy route.',
            'kinds' => ['post-archive', 'taxonomy'],
            'ownership' => 'zeroY owns route identity, locale alternates and SEO metadata; the active theme owns the declared template and visual rendering.',
        ],
        'entityProjection' => [
            'function' => 'zeroy_locale_entities(objectIds, locale, select)',
            'selectors' => ['url', '/post/*', '/acf/*', '/nodes/*'],
            'ownership' => 'Relationship leaves remain canonical IDs. Explicit batch selection resolves locale fields and route URLs.',
        ],
    ];
}

function zeroy_runtime_node_pattern(string $node_id): array|WP_Error
{
    if (!preg_match('/\A[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|\*))*\z/', $node_id)) {
        return zeroy_runtime_error('zeroy_schema_invalid', "Invalid localized NodeId {$node_id}.", 409);
    }
    return explode('.', $node_id);
}

function zeroy_runtime_patterns_overlap(string $left, string $right): bool
{
    $left_segments = explode('.', $left);
    $right_segments = explode('.', $right);
    if (count($left_segments) !== count($right_segments)) {
        return false;
    }
    foreach ($left_segments as $index => $segment) {
        $other = $right_segments[$index];
        if ($segment !== '*' && $other !== '*' && $segment !== $other) {
            return false;
        }
    }
    return true;
}

function zeroy_runtime_schema_violation(array &$errors, string $code, string $message, array $context = []): void
{
    $errors[] = ['code' => $code, 'message' => $message, ...$context];
}

function zeroy_runtime_normalize_localized_nodes(mixed $nodes, array $context, array &$errors, bool $allow_empty = false): array
{
    if (!is_array($nodes) || array_is_list($nodes) && !($allow_empty && count($nodes) === 0)) {
        zeroy_runtime_schema_violation(
            $errors,
            'schema_nodes_invalid',
            'Localized nodes must be a keyed object.',
            [...$context, 'field' => 'nodes', 'expected' => 'keyed object']
        );
        return [];
    }
    $normalized = [];
    $kinds = zeroy_runtime_node_kind_contracts();
    foreach ($nodes as $node_id => $node) {
        $node_context = [...$context, 'nodeId' => is_string($node_id) ? $node_id : null];
        if (!is_string($node_id) || !is_array($node)) {
            zeroy_runtime_schema_violation(
                $errors,
                'schema_node_invalid',
                'Every localized node needs a string NodeId and an object definition.',
                $node_context
            );
            continue;
        }
        $pattern = zeroy_runtime_node_pattern($node_id);
        if (is_wp_error($pattern)) {
            zeroy_runtime_schema_violation(
                $errors,
                'schema_node_id_invalid',
                "Localized NodeId {$node_id} does not match the required NodeId syntax.",
                [...$node_context, 'expectedPattern' => '^[a-z][a-z0-9_]*(?:\\.(?:[a-z][a-z0-9_]*|\\*))*$']
            );
            continue;
        }
        $kind = $node['kind'] ?? null;
        $valid = true;
        if (!is_string($kind) || !isset($kinds[$kind])) {
            zeroy_runtime_schema_violation(
                $errors,
                'schema_node_kind_invalid',
                "Localized node {$node_id} must use a supported kind.",
                [...$node_context, 'field' => 'kind', 'expected' => array_keys($kinds), 'actual' => $kind]
            );
            $valid = false;
        }
        foreach (['required', 'searchable'] as $field) {
            if (!array_key_exists($field, $node) || !is_bool($node[$field])) {
                zeroy_runtime_schema_violation(
                    $errors,
                    'schema_node_boolean_required',
                    "Localized node {$node_id} requires explicit boolean {$field}.",
                    [...$node_context, 'field' => $field, 'expected' => 'boolean', 'actualType' => array_key_exists($field, $node) ? gettype($node[$field]) : 'missing']
                );
                $valid = false;
            }
        }
        if (!$valid) {
            continue;
        }
        $overlaps = false;
        foreach (array_keys($normalized) as $previous) {
            if (!zeroy_runtime_patterns_overlap($previous, $node_id)) {
                continue;
            }
            zeroy_runtime_schema_violation(
                $errors,
                'schema_node_overlap',
                "Localized NodeId {$node_id} overlaps {$previous}.",
                [...$node_context, 'conflictsWith' => $previous]
            );
            $overlaps = true;
        }
        if ($overlaps) {
            continue;
        }
        $normalized[$node_id] = [
            'kind' => $kind,
            'required' => $node['required'],
            'searchable' => $node['searchable'],
        ];
    }
    if (!$allow_empty && count($normalized) === 0) {
        zeroy_runtime_schema_violation(
            $errors,
            'schema_nodes_empty',
            'At least one valid localized node is required.',
            [...$context, 'field' => 'nodes']
        );
    }
    return $normalized;
}

function zeroy_runtime_normalize_collection_route(mixed $route, array $context, array &$errors): ?string
{
    if (!is_string($route)) {
        zeroy_runtime_schema_violation($errors, 'collection_route_invalid', 'Collection route must be a non-empty relative path.', [...$context, 'field' => 'route']);
        return null;
    }
    $normalized = zeroy_runtime_normalize_route($route);
    if (is_wp_error($normalized) || $normalized === '') {
        zeroy_runtime_schema_violation($errors, 'collection_route_invalid', 'Collection route must be a non-empty relative path.', [...$context, 'field' => 'route', 'actual' => $route]);
        return null;
    }
    return $normalized;
}

function zeroy_runtime_collection_route_spaces_overlap(
    string $left_kind,
    string $left_route,
    string $right_kind,
    string $right_route
): bool {
    if ($left_kind === 'post-archive' && $right_kind === 'post-archive') {
        return $left_route === $right_route;
    }
    if ($left_kind === 'taxonomy' && $right_kind === 'taxonomy') {
        return $left_route === $right_route;
    }
    $archive = $left_kind === 'post-archive' ? $left_route : $right_route;
    $taxonomy = $left_kind === 'taxonomy' ? $left_route : $right_route;
    if (!str_starts_with($archive, $taxonomy . '/')) {
        return false;
    }
    return !str_contains(substr($archive, strlen($taxonomy) + 1), '/');
}

/**
 * CollectionRoute is the single declaration for locale-aware collection
 * identity. Query kind and template vary; route ownership, alternates and SEO
 * remain Connector mechanisms.
 */
function zeroy_runtime_normalize_collections(
    mixed $collections,
    array $schemas,
    ?array $theme_copy,
    array &$errors
): array {
    if ($collections === null) {
        return [];
    }
    if (!is_array($collections) || array_is_list($collections)) {
        zeroy_runtime_schema_violation($errors, 'collections_invalid', 'collections must be a keyed object.', ['field' => 'collections']);
        return [];
    }
    $normalized = [];
    $route_spaces = [];
    foreach ($collections as $collection_id => $definition) {
        $context = ['collectionId' => is_string($collection_id) ? $collection_id : null];
        if (
            !is_string($collection_id) ||
            !preg_match('/\A[a-z][a-z0-9-]{0,95}\z/', $collection_id) ||
            !is_array($definition) ||
            array_is_list($definition)
        ) {
            zeroy_runtime_schema_violation($errors, 'collection_invalid', 'Every collection needs a valid collectionId and object definition.', $context);
            continue;
        }
        $kind = $definition['kind'] ?? null;
        if (!in_array($kind, ['post-archive', 'taxonomy'], true)) {
            zeroy_runtime_schema_violation($errors, 'collection_kind_invalid', "Collection {$collection_id} has an unsupported kind.", [...$context, 'field' => 'kind', 'actual' => $kind]);
        }
        $label = is_string($definition['label'] ?? null) ? trim($definition['label']) : '';
        if ($label === '') {
            zeroy_runtime_schema_violation($errors, 'collection_label_invalid', "Collection {$collection_id} requires a non-empty label.", [...$context, 'field' => 'label']);
        }
        $route = zeroy_runtime_normalize_collection_route($definition['route'] ?? null, $context, $errors);
        if ($route !== null && in_array($kind, ['post-archive', 'taxonomy'], true)) {
            foreach ($route_spaces as $existing_id => $existing) {
                if (zeroy_runtime_collection_route_spaces_overlap($kind, $route, $existing['kind'], $existing['route'])) {
                    zeroy_runtime_schema_violation($errors, 'collection_route_overlap', "Collection route {$route} overlaps {$existing_id}.", [...$context, 'field' => 'route', 'conflictsWith' => $existing_id]);
                }
            }
            $route_spaces[$collection_id] = ['kind' => $kind, 'route' => $route];
        }
        $template = $definition['template'] ?? null;
        $normalized_template = is_string($template) ? ltrim(wp_normalize_path($template), '/') : '';
        if ($normalized_template === '' || str_contains($normalized_template, '..') || !preg_match('/\A[a-zA-Z0-9_\-\/]+\.php\z/', $normalized_template) || !is_file(get_stylesheet_directory() . '/' . $normalized_template)) {
            zeroy_runtime_schema_violation($errors, 'collection_template_invalid', "Collection {$collection_id} references a missing or unsafe template.", [...$context, 'field' => 'template', 'actual' => $template]);
        }
        $schema_id = $definition['schemaId'] ?? null;
        if (!is_string($schema_id) || !array_key_exists($schema_id, $schemas)) {
            zeroy_runtime_schema_violation($errors, 'collection_schema_invalid', "Collection {$collection_id} must reference one declared ThemeSchema.", [...$context, 'field' => 'schemaId', 'actual' => $schema_id]);
        }
        $taxonomy = null;
        if ($kind === 'taxonomy') {
            $candidate = $definition['taxonomy'] ?? null;
            if (!is_string($candidate) || $candidate === '' || !taxonomy_exists($candidate)) {
                zeroy_runtime_schema_violation($errors, 'collection_taxonomy_invalid', "Collection {$collection_id} references an unavailable taxonomy.", [...$context, 'field' => 'taxonomy', 'actual' => $candidate]);
            } else {
                $taxonomy = $candidate;
            }
        } elseif (array_key_exists('taxonomy', $definition)) {
            zeroy_runtime_schema_violation($errors, 'collection_taxonomy_unexpected', "Post archive {$collection_id} cannot declare taxonomy.", [...$context, 'field' => 'taxonomy']);
        }
        $title_node = null;
        if (array_key_exists('titleNode', $definition)) {
            $candidate = $definition['titleNode'];
            if (!is_string($candidate) || !is_array($theme_copy) || !array_key_exists($candidate, $theme_copy['nodes'] ?? [])) {
                zeroy_runtime_schema_violation($errors, 'collection_title_node_invalid', "Collection {$collection_id} titleNode must name one declared ThemeCopy node.", [...$context, 'field' => 'titleNode', 'actual' => $candidate]);
            } else {
                $title_node = $candidate;
            }
        }
        if (
            in_array($kind, ['post-archive', 'taxonomy'], true) &&
            $label !== '' &&
            $route !== null &&
            $normalized_template !== '' &&
            is_string($schema_id) &&
            array_key_exists($schema_id, $schemas) &&
            ($kind !== 'taxonomy' || $taxonomy !== null)
        ) {
            $normalized[$collection_id] = [
                'kind' => $kind,
                'label' => $label,
                'route' => $route,
                'template' => $normalized_template,
                'schemaId' => $schema_id,
                ...($taxonomy === null ? [] : ['taxonomy' => $taxonomy]),
                ...($title_node === null ? [] : ['titleNode' => $title_node]),
            ];
        }
    }
    return $normalized;
}

function zeroy_runtime_theme_schema_analysis(array $schema): array
{
    $errors = [];
    if (($schema['contract'] ?? null) !== ZEROY_THEME_SCHEMA_CONTRACT) {
        zeroy_runtime_schema_violation($errors, 'schema_contract_invalid', 'ThemeSchema has an unsupported contract.', ['field' => 'contract', 'expected' => ZEROY_THEME_SCHEMA_CONTRACT, 'actual' => $schema['contract'] ?? null]);
    }
    $schemas = $schema['schemas'] ?? null;
    if (!is_array($schemas) || array_is_list($schemas)) {
        zeroy_runtime_schema_violation($errors, 'schema_schemas_invalid', 'ThemeSchema requires a keyed schemas object.', ['field' => 'schemas', 'expected' => 'keyed object']);
        return ['schema' => null, 'errors' => $errors];
    }
    $normalized = ['contract' => ZEROY_THEME_SCHEMA_CONTRACT, 'schemas' => []];
    foreach ($schemas as $schema_id => $definition) {
        if (!is_string($schema_id) || !preg_match('/\A[a-z][a-z0-9-]{0,95}\z/', $schema_id) || !is_array($definition)) {
            zeroy_runtime_schema_violation($errors, 'schema_id_invalid', 'Every ThemeSchema entry needs a valid schemaId and object definition.', ['schemaId' => is_string($schema_id) ? $schema_id : null]);
            continue;
        }
        $context = ['schemaId' => $schema_id];
        $label = trim((string) ($definition['label'] ?? ''));
        if ($label === '') {
            zeroy_runtime_schema_violation($errors, 'schema_label_invalid', "Schema {$schema_id} requires a non-empty label.", [...$context, 'field' => 'label']);
        }
        $template = $definition['template'] ?? null;
        $normalized_template = is_string($template) ? ltrim(wp_normalize_path($template), '/') : '';
        if ($normalized_template === '' || str_contains($normalized_template, '..') || !preg_match('/\A[a-zA-Z0-9_\-\/]+\.php\z/', $normalized_template) || !is_file(get_stylesheet_directory() . '/' . $normalized_template)) {
            zeroy_runtime_schema_violation($errors, 'schema_template_invalid', "Schema {$schema_id} references a missing or unsafe template.", [...$context, 'field' => 'template', 'actual' => $template]);
        }
        $post_types = $definition['canonicalPostTypes'] ?? null;
        $normalized_post_types = [];
        if (!is_array($post_types) || !array_is_list($post_types) || count($post_types) === 0) {
            zeroy_runtime_schema_violation($errors, 'schema_post_types_invalid', "Schema {$schema_id} requires a non-empty canonicalPostTypes list.", [...$context, 'field' => 'canonicalPostTypes']);
        } else {
            foreach ($post_types as $post_type) {
                $post_type = is_string($post_type) ? $post_type : '';
                if ($post_type === '' || !post_type_exists($post_type) || in_array($post_type, $normalized_post_types, true)) {
                    zeroy_runtime_schema_violation($errors, 'schema_post_type_invalid', "Schema {$schema_id} has an invalid or duplicate canonical post type.", [...$context, 'field' => 'canonicalPostTypes', 'actual' => $post_type]);
                    continue;
                }
                $normalized_post_types[] = $post_type;
            }
        }
        $normalized_nodes = zeroy_runtime_normalize_localized_nodes($definition['nodes'] ?? null, $context, $errors, true);
        $title_node = null;
        if (array_key_exists('titleNode', $definition)) {
            $candidate = $definition['titleNode'];
            if (
                !is_string($candidate) ||
                $candidate === '' ||
                str_contains($candidate, '*') ||
                !array_key_exists($candidate, $normalized_nodes)
            ) {
                zeroy_runtime_schema_violation(
                    $errors,
                    'schema_title_node_invalid',
                    "Schema {$schema_id} titleNode must name one declared, non-wildcard localized node.",
                    [...$context, 'field' => 'titleNode', 'actual' => $candidate]
                );
            } else {
                $title_node = $candidate;
            }
        }
        if ($label !== '' && $normalized_template !== '' && is_array($post_types) && array_is_list($post_types) && count($normalized_post_types) === count($post_types)) {
            $normalized['schemas'][$schema_id] = [
                'label' => $label,
                'template' => $normalized_template,
                'canonicalPostTypes' => $normalized_post_types,
                'nodes' => $normalized_nodes,
                ...($title_node === null ? [] : ['titleNode' => $title_node]),
            ];
        }
    }
    if (count($schemas) === 0) {
        zeroy_runtime_schema_violation($errors, 'schema_empty', 'ThemeSchema must declare at least one schema.', ['field' => 'schemas']);
    }
    if (array_key_exists('themeCopy', $schema)) {
        $theme_copy = $schema['themeCopy'];
        if (!is_array($theme_copy) || array_is_list($theme_copy)) {
            zeroy_runtime_schema_violation($errors, 'theme_copy_invalid', 'themeCopy must be an object with keyed nodes.', ['field' => 'themeCopy']);
        } else {
            $normalized_nodes = zeroy_runtime_normalize_localized_nodes($theme_copy['nodes'] ?? null, ['scope' => 'themeCopy'], $errors);
            if (count($normalized_nodes) > 0) {
                $normalized['themeCopy'] = ['nodes' => $normalized_nodes];
            }
        }
    }
    $normalized_collections = zeroy_runtime_normalize_collections(
        $schema['collections'] ?? null,
        $normalized['schemas'],
        $normalized['themeCopy'] ?? null,
        $errors
    );
    if (count($normalized_collections) > 0) {
        $normalized['collections'] = $normalized_collections;
    }
    return ['schema' => count($errors) === 0 ? $normalized : null, 'errors' => $errors];
}

function zeroy_runtime_candidate_schema_diagnostics(): array
{
    $path = get_stylesheet_directory() . '/zeroy.schema.json';
    if (!is_file($path) || is_link($path)) {
        return ['valid' => false, 'errors' => [['code' => 'schema_missing', 'message' => 'The active theme has no regular zeroy.schema.json file.']]];
    }
    $raw = file_get_contents($path);
    $schema = is_string($raw) ? zeroy_runtime_decode_json($raw) : zeroy_runtime_error('zeroy_schema_invalid', 'Could not read zeroy.schema.json.', 409);
    if (is_wp_error($schema)) {
        return ['valid' => false, 'errors' => [['code' => 'schema_invalid_json', 'message' => $schema->get_error_message()]]];
    }
    $analysis = zeroy_runtime_theme_schema_analysis($schema);
    if (count($analysis['errors']) > 0 || !is_array($analysis['schema'])) {
        return ['valid' => false, 'errors' => $analysis['errors']];
    }
    return [
        'valid' => true,
        'schema' => $analysis['schema'],
        'contractHash' => zeroy_runtime_hash($analysis['schema']),
        'schemaHashes' => zeroy_runtime_schema_hashes($analysis['schema']),
        'errors' => [],
    ];
}

function zeroy_runtime_active_schema_row(): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        'SELECT schema_json, contract_hash, activated_at FROM ' . zeroy_runtime_table('schema_state') . ' WHERE singleton = 1',
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_active_schema_contract_hash(): string|WP_Error
{
    $row = zeroy_runtime_active_schema_row();
    return is_array($row)
        ? (string) $row['contract_hash']
        : zeroy_runtime_error('zeroy_schema_not_activated', 'No active ThemeSchema snapshot is available.', 409);
}

function zeroy_runtime_schema_diagnostics(): array
{
    $row = zeroy_runtime_active_schema_row();
    if ($row === null) {
        return ['valid' => false, 'errors' => [[
            'code' => 'schema_not_activated',
            'message' => 'The active theme has no activated ThemeSchema snapshot. Apply zeroy.schema.json through the Connector.',
        ]]];
    }
    $schema = zeroy_runtime_decode_json((string) $row['schema_json']);
    if (is_wp_error($schema)) {
        return ['valid' => false, 'errors' => [[
            'code' => 'schema_snapshot_invalid',
            'message' => 'The activated ThemeSchema snapshot is invalid JSON.',
        ]]];
    }
    $analysis = zeroy_runtime_theme_schema_analysis($schema);
    if (count($analysis['errors']) > 0 || !is_array($analysis['schema'])) {
        return ['valid' => false, 'errors' => $analysis['errors']];
    }
    $contract_hash = zeroy_runtime_hash($analysis['schema']);
    if (!hash_equals((string) $row['contract_hash'], $contract_hash)) {
        return ['valid' => false, 'errors' => [[
            'code' => 'schema_snapshot_hash_mismatch',
            'message' => 'The activated ThemeSchema snapshot does not match its contract hash.',
        ]]];
    }
    return [
        'valid' => true,
        'schema' => $analysis['schema'],
        'contractHash' => $contract_hash,
        'schemaHashes' => zeroy_runtime_schema_hashes($analysis['schema']),
        'activatedAt' => $row['activated_at'],
        'errors' => [],
    ];
}

function zeroy_runtime_validate_theme_schema(array $schema): array|WP_Error
{
    $analysis = zeroy_runtime_theme_schema_analysis($schema);
    if (count($analysis['errors']) > 0 || !is_array($analysis['schema'])) {
        return zeroy_runtime_error(
            'zeroy_schema_invalid',
            'ThemeSchema has ' . count($analysis['errors']) . ' violation(s).',
            409,
            ['violations' => $analysis['errors']]
        );
    }
    return $analysis['schema'];
}

function zeroy_runtime_theme_schema(): array|WP_Error
{
    $diagnostics = zeroy_runtime_schema_diagnostics();
    if (!$diagnostics['valid']) {
        return zeroy_runtime_error(
            'zeroy_schema_invalid',
            'ThemeSchema is invalid.',
            409,
            ['violations' => $diagnostics['errors']]
        );
    }
    return $diagnostics['schema'];
}

function zeroy_runtime_schema_hash(array $definition): string
{
    return zeroy_runtime_hash(['nodes' => $definition['nodes']]);
}

function zeroy_runtime_schema_hashes(array $schema): array
{
    $hashes = [];
    foreach ($schema['schemas'] as $schema_id => $definition) {
        $hashes[$schema_id] = zeroy_runtime_schema_hash($definition);
    }
    return $hashes;
}

function zeroy_runtime_schema_definition(string $schema_id): array|WP_Error
{
    $schema = zeroy_runtime_theme_schema();
    if (is_wp_error($schema)) {
        return $schema;
    }
    $definition = $schema['schemas'][$schema_id] ?? null;
    if (!is_array($definition)) {
        return zeroy_runtime_error('zeroy_schema_not_found', "Unknown ThemeSchema {$schema_id}.", 404);
    }
    return $definition;
}

function zeroy_runtime_collection_definitions(): array|WP_Error
{
    $schema = zeroy_runtime_theme_schema();
    if (is_wp_error($schema)) {
        return $schema;
    }
    return is_array($schema['collections'] ?? null) ? $schema['collections'] : [];
}

function zeroy_runtime_collection_for_relative_route(string $route, ?array $collections = null): ?array
{
    if ($collections === null) {
        $collections = zeroy_runtime_collection_definitions();
        if (is_wp_error($collections)) {
            return null;
        }
    }
    foreach ($collections as $collection_id => $definition) {
        $base = (string) $definition['route'];
        if ($definition['kind'] === 'post-archive' && $route === $base) {
            return ['collectionId' => $collection_id, 'definition' => $definition, 'termSlug' => null];
        }
        if ($definition['kind'] === 'taxonomy' && str_starts_with($route, $base . '/')) {
            $term_slug = substr($route, strlen($base) + 1);
            if ($term_slug !== '' && !str_contains($term_slug, '/')) {
                return ['collectionId' => $collection_id, 'definition' => $definition, 'termSlug' => $term_slug];
            }
        }
    }
    return null;
}

function zeroy_runtime_collection_route_conflicts(array $schema): array
{
    $collections = is_array($schema['collections'] ?? null) ? $schema['collections'] : [];
    if (count($collections) === 0) {
        return [];
    }
    global $wpdb;
    $rows = $wpdb->get_results('SELECT locale, route_path, object_id FROM ' . zeroy_runtime_table('route_reservations') . ' ORDER BY locale, route_path', ARRAY_A);
    $conflicts = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $owner = zeroy_runtime_collection_for_relative_route((string) $row['route_path'], $collections);
        if ($owner !== null) {
            $conflicts[] = [
                'code' => 'collection_route_reserved',
                'message' => 'A declared collection route overlaps an existing canonical route reservation.',
                'collectionId' => $owner['collectionId'],
                'locale' => $row['locale'],
                'route' => $row['route_path'],
                'objectId' => (int) $row['object_id'],
            ];
        }
    }
    return $conflicts;
}

function zeroy_runtime_sync_collection_route_reservations(array $schema): array
{
    $collections = is_array($schema['collections'] ?? null) ? $schema['collections'] : [];
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return ['created' => 0, 'current' => 0, 'conflicts' => [[
            'code' => $config->get_error_code(),
            'message' => $config->get_error_message(),
        ]]];
    }
    global $wpdb;
    $table = zeroy_runtime_table('collection_route_reservations');
    $created = 0;
    $current = 0;
    $conflicts = zeroy_runtime_collection_route_conflicts($schema);
    foreach ($config['enabledLocales'] as $locale) {
        $existing_rows = $wpdb->get_results(
            $wpdb->prepare(
                "SELECT route_path, collection_id, kind FROM {$table} WHERE locale = %s",
                $locale['locale']
            ),
            ARRAY_A
        );
        foreach ($collections as $collection_id => $definition) {
            $has_current = false;
            $has_conflict = false;
            foreach (is_array($existing_rows) ? $existing_rows : [] as $existing) {
                if (!zeroy_runtime_collection_route_spaces_overlap(
                    $definition['kind'],
                    $definition['route'],
                    $existing['kind'],
                    $existing['route_path']
                )) {
                    continue;
                }
                if (
                    $existing['route_path'] === $definition['route'] &&
                    $existing['collection_id'] === $collection_id &&
                    $existing['kind'] === $definition['kind']
                ) {
                    $has_current = true;
                } else {
                    $has_conflict = true;
                    $conflicts[] = [
                        'code' => 'collection_route_taken',
                        'message' => 'This locale collection route overlaps a permanent collection reservation.',
                        'collectionId' => $collection_id,
                        'conflictsWith' => $existing['collection_id'],
                        'locale' => $locale['locale'],
                        'route' => $definition['route'],
                        'conflictingRoute' => $existing['route_path'],
                    ];
                }
            }
            if ($has_current && !$has_conflict) {
                $current++;
                continue;
            }
            if ($has_conflict || count(array_filter(
                $conflicts,
                static fn(array $conflict): bool => ($conflict['collectionId'] ?? null) === $collection_id && ($conflict['locale'] ?? null) === $locale['locale']
            )) > 0) {
                continue;
            }
            $written = $wpdb->insert(
                $table,
                [
                    'locale' => $locale['locale'],
                    'route_path' => $definition['route'],
                    'url_prefix' => $locale['urlPrefix'],
                    'collection_id' => $collection_id,
                    'kind' => $definition['kind'],
                    'reserved_at' => current_time('mysql', true),
                ],
                ['%s', '%s', '%s', '%s', '%s', '%s']
            );
            if ($written === 1) {
                $created++;
                $existing_rows[] = [
                    'route_path' => $definition['route'],
                    'collection_id' => $collection_id,
                    'kind' => $definition['kind'],
                ];
            } else {
                $conflicts[] = [
                    'code' => 'collection_route_reservation_failed',
                    'message' => $wpdb->last_error ?: 'Could not reserve collection route.',
                    'collectionId' => $collection_id,
                    'locale' => $locale['locale'],
                    'route' => $definition['route'],
                ];
            }
        }
    }
    return ['created' => $created, 'current' => $current, 'conflicts' => $conflicts];
}

function zeroy_runtime_reserved_collection_for_relative_route(string $locale, string $route): ?array
{
    global $wpdb;
    $rows = $wpdb->get_results(
        $wpdb->prepare(
            'SELECT locale, route_path, url_prefix, collection_id, kind FROM ' . zeroy_runtime_table('collection_route_reservations') . ' WHERE locale = %s ORDER BY CHAR_LENGTH(route_path) DESC',
            $locale
        ),
        ARRAY_A
    );
    foreach (is_array($rows) ? $rows : [] as $row) {
        if ($row['kind'] === 'post-archive' && $route === $row['route_path']) {
            return [...$row, 'termSlug' => null];
        }
        if ($row['kind'] === 'taxonomy' && str_starts_with($route, $row['route_path'] . '/')) {
            $term_slug = substr($route, strlen($row['route_path']) + 1);
            if ($term_slug !== '' && !str_contains($term_slug, '/')) {
                return [...$row, 'termSlug' => $term_slug];
            }
        }
    }
    return null;
}

function zeroy_runtime_theme_copy_definition(): array|WP_Error
{
    $schema = zeroy_runtime_theme_schema();
    if (is_wp_error($schema)) {
        return $schema;
    }
    $theme_copy = $schema['themeCopy'] ?? null;
    if (!is_array($theme_copy) || !is_array($theme_copy['nodes'] ?? null)) {
        return zeroy_runtime_error(
            'zeroy_theme_copy_not_declared',
            'The active ThemeSchema does not declare themeCopy.nodes.',
            409
        );
    }
    return $theme_copy;
}

function zeroy_runtime_document_definition(int $object_id, string $schema_id): array|WP_Error
{
    if ($object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        if ($schema_id !== ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID) {
            return zeroy_runtime_error('zeroy_theme_copy_schema_invalid', 'ThemeCopy must use the reserved ThemeCopy schema.', 409);
        }
        return zeroy_runtime_theme_copy_definition();
    }
    return zeroy_runtime_schema_definition($schema_id);
}

function zeroy_runtime_node_matches(string $node_id, string $pattern): bool
{
    $actual = explode('.', $node_id);
    $expected = explode('.', $pattern);
    if (count($actual) !== count($expected)) {
        return false;
    }
    foreach ($expected as $index => $segment) {
        if ($segment !== '*' && $actual[$index] !== $segment) {
            return false;
        }
    }
    return true;
}

function zeroy_runtime_document_node(array $definition, string $node_id): ?array
{
    foreach ($definition['nodes'] as $pattern => $node) {
        if (zeroy_runtime_node_matches($node_id, $pattern)) {
            return $node;
        }
    }
    return null;
}

function zeroy_runtime_document_violations(array $document, array $definition, bool $complete): array
{
    $violations = [];
    if (array_is_list($document) && count($document) > 0) {
        return [[
            'code' => 'document_not_keyed',
            'message' => 'Locale documents must be keyed by NodeId.',
        ]];
    }
    foreach ($document as $node_id => $value) {
        if (!is_string($node_id)) {
            $violations[] = [
                'code' => 'document_node_id_invalid',
                'message' => 'Locale document NodeIds must be strings.',
            ];
            continue;
        }
        if (!is_string($value)) {
            $violations[] = [
                'code' => 'document_value_invalid',
                'nodeId' => $node_id,
                'message' => "Localized NodeId {$node_id} must have a string value.",
            ];
            continue;
        }
        if (zeroy_runtime_document_node($definition, $node_id) === null) {
            $violations[] = [
                'code' => 'document_node_unknown',
                'nodeId' => $node_id,
                'message' => "Localized NodeId {$node_id} is not declared by the active ThemeSchema.",
            ];
        }
    }
    if ($complete) {
        foreach ($definition['nodes'] as $node_id => $node) {
            if ($node['required'] && !str_contains($node_id, '*') && (!isset($document[$node_id]) || trim($document[$node_id]) === '')) {
                $violations[] = [
                    'code' => 'document_node_required',
                    'nodeId' => $node_id,
                    'message' => "Required localized NodeId {$node_id} is missing.",
                ];
            }
        }
    }
    return $violations;
}

function zeroy_runtime_validate_document(array $document, array $definition, bool $complete): array|WP_Error
{
    $violations = zeroy_runtime_document_violations($document, $definition, $complete);
    if (count($violations) === 0) {
        return $document;
    }
    $first = $violations[0];
    $incomplete = $first['code'] === 'document_node_required';
    return zeroy_runtime_error(
        $incomplete ? 'zeroy_document_incomplete' : 'zeroy_document_invalid',
        $first['message'],
        $incomplete ? 409 : 400,
        ['violations' => $violations]
    );
}

/**
 * A ThemeSchema hard cut has one lossless structural transform: values for
 * NodeIds removed from the new schema are no longer part of the document
 * algebra, so they are removed from the replacement immutable version. No
 * values are synthesized for new required nodes and no old schema is retained
 * as a reader fallback.
 *
 * @return array{document: array, removedNodeIds: list<string>}
 */
function zeroy_runtime_hard_migrate_document(array $document, array $definition): array
{
    $theme_copy = ($document['contract'] ?? null) === ZEROY_THEME_COPY_VERSION_CONTRACT;
    $locale = ($document['contract'] ?? null) === ZEROY_LOCALE_VERSION_CONTRACT;
    if (!$theme_copy && !$locale) {
        return ['document' => $document, 'removedNodeIds' => []];
    }
    $nodes = is_array($document['nodes'] ?? null) ? $document['nodes'] : [];
    $migrated = $nodes;
    $removed = [];
    foreach ($nodes as $node_id => $_value) {
        if (!is_string($node_id) || zeroy_runtime_document_node($definition, $node_id) !== null) {
            continue;
        }
        unset($migrated[$node_id]);
        $removed[] = $node_id;
    }
    sort($removed, SORT_STRING);
    return ['document' => [...$document, 'nodes' => $migrated], 'removedNodeIds' => $removed];
}

function zeroy_runtime_canonical(int $object_id): array|WP_Error
{
    $post = get_post($object_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_canonical_missing', "Canonical WordPress object {$object_id} does not exist.", 404);
    }
    $schema_id = (string) get_post_meta($object_id, ZEROY_RUNTIME_SCHEMA_META, true);
    $revision = (int) get_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, true);
    if ($schema_id === '' || $revision < 1) {
        return zeroy_runtime_error('zeroy_canonical_unassigned', "WordPress object {$object_id} is not a zeroY canonical object.", 409);
    }
    return ['objectId' => $object_id, 'post' => $post, 'schemaId' => $schema_id, 'revision' => $revision];
}

function zeroy_runtime_create_canonical(string $post_type, string $schema_id, string $post_title): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_type, $schema_id, $post_title) {
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        if (!in_array($post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', "Post type {$post_type} is not allowed by ThemeSchema {$schema_id}.", 400);
        }
        $object_id = wp_insert_post([
            'post_type' => $post_type,
            'post_status' => 'draft',
            'post_title' => $post_title !== '' ? $post_title : 'zeroY canonical object',
        ], true);
        if (is_wp_error($object_id)) {
            return zeroy_runtime_error('zeroy_canonical_create_failed', $object_id->get_error_message(), 500);
        }
        update_post_meta((int) $object_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
        update_post_meta((int) $object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1);
        return zeroy_runtime_canonical((int) $object_id);
    });
}

function zeroy_runtime_existing_post_facts(WP_Post $post): array
{
    // existingPost is the Agent's template-authoring projection. Its keys and
    // values must match ACF's runtime get_field()/get_fields() view, not the
    // internal database/field-key representation used for storage.
    $acf = function_exists('get_fields') ? get_fields($post->ID, true) : [];
    return [
        'post' => [
            'postId' => (int) $post->ID,
            'postType' => $post->post_type,
            'postStatus' => $post->post_status,
            'postTitle' => $post->post_title,
            'postName' => $post->post_name,
            'postContent' => $post->post_content,
            'postExcerpt' => $post->post_excerpt,
            'modifiedGmt' => $post->post_modified_gmt,
            'permalink' => get_permalink($post) ?: null,
        ],
        'acf' => is_array($acf) ? $acf : [],
    ];
}

function zeroy_runtime_existing_post_projection(WP_Post $post): array
{
    $facts = zeroy_runtime_existing_post_facts($post);
    return [
        ...$facts,
        'sourceHash' => zeroy_runtime_hash($facts),
    ];
}

function zeroy_runtime_adoption_candidate_projection(WP_Post $post): array
{
    $facts = zeroy_runtime_existing_post_facts($post);
    return [
        'postId' => $facts['post']['postId'],
        'postType' => $facts['post']['postType'],
        'postStatus' => $facts['post']['postStatus'],
        'postTitle' => $facts['post']['postTitle'],
        'permalink' => $facts['post']['permalink'],
        'modifiedGmt' => $facts['post']['modifiedGmt'],
        'acfFieldNames' => array_keys($facts['acf']),
        'sourceHash' => zeroy_runtime_hash($facts),
    ];
}

function zeroy_runtime_adoption_candidates(?string $post_type, ?string $schema_id, int $page = 1, int $per_page = 50): array|WP_Error
{
    global $wpdb;
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $where = 'schema_meta.post_id IS NULL AND p.post_status NOT IN (\'auto-draft\', \'trash\', \'inherit\') AND p.post_type NOT IN (\'revision\', \'attachment\', \'nav_menu_item\', \'custom_css\', \'customize_changeset\')';
    $arguments = [ZEROY_RUNTIME_SCHEMA_META];
    if ($post_type !== null && $post_type !== '') {
        if (!post_type_exists($post_type)) {
            return zeroy_runtime_error('zeroy_adoption_post_type_invalid', "Unknown WordPress post type {$post_type}.", 400);
        }
        $where .= ' AND p.post_type = %s';
        $arguments[] = $post_type;
    }
    if ($schema_id !== null && $schema_id !== '') {
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        $allowed = $definition['canonicalPostTypes'];
        $placeholders = implode(', ', array_fill(0, count($allowed), '%s'));
        $where .= " AND p.post_type IN ({$placeholders})";
        array_push($arguments, ...$allowed);
    }
    $from = ' FROM ' . $wpdb->posts . ' p LEFT JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s';
    $count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*)' . $from . ' WHERE ' . $where, ...$arguments));
    $offset = ($page - 1) * $per_page;
    $rows = $wpdb->get_results(
        $wpdb->prepare('SELECT p.ID FROM ' . $wpdb->posts . ' p LEFT JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s WHERE ' . $where . ' ORDER BY p.ID DESC LIMIT %d OFFSET %d', ...[...$arguments, $per_page, $offset]),
        ARRAY_A
    );
    $items = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $post = get_post((int) $row['ID']);
        if ($post instanceof WP_Post) {
            $items[] = zeroy_runtime_adoption_candidate_projection($post);
        }
    }
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $count];
}

function zeroy_runtime_existing_unmanaged_post(int $post_id): array|WP_Error
{
    $post = get_post($post_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_existing_post_missing', "WordPress post {$post_id} does not exist.", 404);
    }
    if ((string) get_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, true) !== '') {
        return zeroy_runtime_error('zeroy_existing_post_adopted', "WordPress post {$post_id} is already a zeroY canonical object.", 409);
    }
    return zeroy_runtime_existing_post_projection($post);
}

function zeroy_runtime_adopt_canonical(int $post_id, string $schema_id, string $expected_source_hash): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($post_id, $schema_id, $expected_source_hash) {
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $projection = zeroy_runtime_existing_unmanaged_post($post_id);
        if (is_wp_error($projection)) {
            return $projection;
        }
        $current_hash = $projection['sourceHash'];
        if (!hash_equals($current_hash, $expected_source_hash)) {
            return zeroy_runtime_error(
                'zeroy_adoption_source_conflict',
                'WordPress or ACF facts changed after this post was read.',
                409,
                ['currentSourceHash' => $current_hash]
            );
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        $post = get_post($post_id);
        if (!$post instanceof WP_Post || !in_array($post->post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', 'The selected ThemeSchema does not allow this WordPress post type.', 400);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id, true)) {
            return zeroy_runtime_error('zeroy_canonical_already_adopted', 'WordPress post became a zeroY canonical object before adoption completed.', 409);
        }
        if (!add_post_meta($post_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, 1, true)) {
            delete_post_meta($post_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
            return zeroy_runtime_error('zeroy_canonical_adoption_failed', 'Could not initialize canonical revision during adoption.', 500);
        }
        return zeroy_runtime_canonical($post_id);
    });
}

function zeroy_runtime_assign_canonical_schema(int $object_id, string $schema_id, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_transaction(function () use ($object_id, $schema_id, $expected_revision) {
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) {
            return $canonical;
        }
        if ($canonical['revision'] !== $expected_revision) {
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, ['currentRevision' => $canonical['revision']]);
        }
        $definition = zeroy_runtime_schema_definition($schema_id);
        if (is_wp_error($definition)) {
            return $definition;
        }
        if (!in_array($canonical['post']->post_type, $definition['canonicalPostTypes'], true)) {
            return zeroy_runtime_error('zeroy_canonical_post_type_invalid', 'The selected ThemeSchema does not allow this canonical object type.', 400);
        }
        $heads = zeroy_runtime_heads_for_object($object_id);
        if (count($heads) > 0) {
            return zeroy_runtime_error('zeroy_schema_assignment_locked', 'A canonical object with locale documents cannot change ThemeSchema.', 409);
        }
        $next_revision = $expected_revision + 1;
        $updated = update_post_meta($object_id, ZEROY_RUNTIME_CANONICAL_REVISION_META, $next_revision, $expected_revision);
        if ($updated === false) {
            $fresh = zeroy_runtime_canonical($object_id);
            return zeroy_runtime_error('zeroy_canonical_conflict', 'Canonical object changed after it was read.', 409, [
                'currentRevision' => is_array($fresh) ? $fresh['revision'] : null,
            ]);
        }
        update_post_meta($object_id, ZEROY_RUNTIME_SCHEMA_META, $schema_id);
        return zeroy_runtime_canonical($object_id);
    });
}

function zeroy_runtime_get_head(int $object_id, string $locale): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = %d AND locale = %s', $object_id, $locale),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_locked_head(int $object_id, string $locale): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = %d AND locale = %s', $object_id, $locale),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_heads_for_object(int $object_id): array
{
    global $wpdb;
    $rows = $wpdb->get_results(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = %d ORDER BY locale ASC', $object_id),
        ARRAY_A
    );
    return is_array($rows) ? $rows : [];
}

function zeroy_runtime_get_version(int $version_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_versions') . ' WHERE version_id = %d', $version_id),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_runtime_insert_version(int $object_id, string $locale, string $schema_id, string $schema_hash, array $document): int|WP_Error
{
    global $wpdb;
    $written = $wpdb->insert(
        zeroy_runtime_table('locale_versions'),
        [
            'object_id' => $object_id,
            'locale' => $locale,
            'schema_id' => $schema_id,
            'schema_hash' => $schema_hash,
            'document_json' => zeroy_runtime_json($document),
            'created_at' => current_time('mysql', true),
        ],
        ['%d', '%s', '%s', '%s', '%s', '%s']
    );
    if ($written !== 1) {
        return zeroy_runtime_error('zeroy_version_write_failed', $wpdb->last_error ?: 'Could not create LocaleVersion.', 500);
    }
    return (int) $wpdb->insert_id;
}

function zeroy_runtime_transaction(callable $operation): mixed
{
    global $wpdb;
    if ($wpdb->query('START TRANSACTION') === false) {
        return zeroy_runtime_error('zeroy_transaction_unavailable', 'Could not begin the LocaleStore transaction.', 500);
    }
    try {
        $result = $operation();
        if (is_wp_error($result)) {
            $wpdb->query('ROLLBACK');
            return $result;
        }
        if ($wpdb->query('COMMIT') === false) {
            $wpdb->query('ROLLBACK');
            return zeroy_runtime_error('zeroy_transaction_commit_failed', 'Could not commit the LocaleStore transaction.', 500);
        }
        return $result;
    } catch (Throwable $error) {
        $wpdb->query('ROLLBACK');
        return zeroy_runtime_error('zeroy_transaction_failed', $error->getMessage(), 500);
    }
}

function zeroy_runtime_acquire_schema_lease(): true|WP_Error
{
    global $wpdb;
    $updated = $wpdb->query(
        'UPDATE ' . zeroy_runtime_table('runtime_locks') . " SET revision = revision + 1 WHERE lock_name = 'schema-deployment'"
    );
    return $updated === 1
        ? true
        : zeroy_runtime_error('zeroy_schema_lease_unavailable', $wpdb->last_error ?: 'Could not acquire the schema deployment lease.', 500);
}

function zeroy_runtime_reserve_route(string $locale, string $route, int $object_id, string $url_prefix): true|WP_Error
{
    $collection = zeroy_runtime_reserved_collection_for_relative_route($locale, $route)
        ?? zeroy_runtime_collection_for_relative_route($route);
    if ($collection !== null) {
        return zeroy_runtime_error(
            'zeroy_route_taken',
            'This locale route is owned by a declared collection.',
            409,
            ['collectionId' => $collection['collectionId'] ?? $collection['collection_id'], 'locale' => $locale, 'route' => $route]
        );
    }
    global $wpdb;
    $table = zeroy_runtime_table('route_reservations');
    $existing = $wpdb->get_row(
        $wpdb->prepare("SELECT object_id FROM {$table} WHERE locale = %s AND route_path = %s", $locale, $route),
        ARRAY_A
    );
    if (is_array($existing)) {
        return (int) $existing['object_id'] === $object_id
            ? true
            : zeroy_runtime_error('zeroy_route_taken', 'This locale route is already reserved by another canonical object.', 409);
    }
    $written = $wpdb->insert(
        $table,
        ['locale' => $locale, 'route_path' => $route, 'url_prefix' => $url_prefix, 'object_id' => $object_id, 'reserved_at' => current_time('mysql', true)],
        ['%s', '%s', '%s', '%d', '%s']
    );
    if ($written !== 1) {
        return zeroy_runtime_error('zeroy_route_reservation_failed', $wpdb->last_error ?: 'Could not reserve locale route.', 409);
    }
    return true;
}

function zeroy_runtime_document_cache_key(int $object_id, string $locale, int $version_id, string $schema_hash): string
{
    return 'document:' . $object_id . ':' . $locale . ':' . $version_id . ':' . $schema_hash;
}

function zeroy_runtime_invalidate_document_cache(?array $head): void
{
    if (!is_array($head) || empty($head['published_version_id'])) {
        return;
    }
    $version = zeroy_runtime_get_version((int) $head['published_version_id']);
    if (!is_array($version)) {
        return;
    }
    wp_cache_delete(
        zeroy_runtime_document_cache_key((int) $head['object_id'], (string) $head['locale'], (int) $version['version_id'], (string) $version['schema_hash']),
        'zeroy-runtime'
    );
}

function zeroy_runtime_write_draft(
    int $object_id,
    string $locale,
    string $schema_id,
    string $route,
    array $document,
    int $expected_revision
): array|WP_Error {
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    if ($canonical['schemaId'] !== $schema_id) {
        return zeroy_runtime_error('zeroy_schema_assignment_mismatch', 'Locale content must use the canonical object\'s assigned ThemeSchema.', 409);
    }
    return zeroy_runtime_write_versioned_document(
        $object_id,
        $locale,
        $schema_id,
        $route,
        $document,
        $expected_revision,
        true
    );
}

function zeroy_runtime_write_theme_copy_draft(string $locale, array $document, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_write_versioned_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID,
        '',
        $document,
        $expected_revision,
        false
    );
}

function zeroy_runtime_commit_locale(
    int $object_id,
    string $locale,
    string $schema_id,
    string $route,
    array $document,
    int $expected_revision
): array|WP_Error {
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    if ($canonical['schemaId'] !== $schema_id) {
        return zeroy_runtime_error('zeroy_schema_assignment_mismatch', 'Locale content must use the canonical object\'s assigned ThemeSchema.', 409);
    }
    return zeroy_runtime_write_versioned_document(
        $object_id,
        $locale,
        $schema_id,
        $route,
        $document,
        $expected_revision,
        true,
        true
    );
}

function zeroy_runtime_commit_theme_copy(string $locale, array $document, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_write_versioned_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID,
        '',
        $document,
        $expected_revision,
        false,
        true
    );
}

function zeroy_runtime_patch_theme_copy_draft(string $locale, array $changes, int $expected_revision): array|WP_Error
{
    if (array_is_list($changes) || count($changes) === 0) {
        return zeroy_runtime_error('zeroy_theme_copy_patch_invalid', 'changes must be a non-empty keyed object of string values or null deletions.', 400);
    }
    foreach ($changes as $node_id => $value) {
        if (!is_string($node_id) || $node_id === '' || !is_string($value) && $value !== null) {
            return zeroy_runtime_error('zeroy_theme_copy_patch_invalid', 'Each ThemeCopy patch entry needs a string NodeId and a string value or null deletion.', 400);
        }
    }
    $head = zeroy_runtime_get_head(ZEROY_RUNTIME_THEME_COPY_OBJECT_ID, $locale);
    $current_revision = $head === null ? 0 : (int) $head['revision'];
    if ($current_revision !== $expected_revision) {
        return zeroy_runtime_error('zeroy_locale_conflict', 'ThemeCopy LocaleHead changed after it was read.', 409, ['currentRevision' => $current_revision]);
    }
    $base = [];
    if ($head !== null) {
        $base_version_id = $head['draft_version_id'] ?? $head['published_version_id'];
        if ($base_version_id !== null) {
            $version = zeroy_runtime_get_version((int) $base_version_id);
            if ($version === null) {
                return zeroy_runtime_error('zeroy_version_missing', 'ThemeCopy base LocaleVersion is missing.', 409);
            }
            $stored = zeroy_runtime_decode_json((string) $version['document_json']);
            if (is_wp_error($stored) || ($stored['contract'] ?? null) !== ZEROY_THEME_COPY_VERSION_CONTRACT || !is_array($stored['nodes'] ?? null)) {
                return zeroy_runtime_error('zeroy_document_invalid', 'ThemeCopy base JSON is invalid.', 409);
            }
            $base = $stored['nodes'];
        }
    }
    foreach ($changes as $node_id => $value) {
        if ($value === null) {
            unset($base[$node_id]);
        } else {
            $base[$node_id] = $value;
        }
    }
    return zeroy_runtime_write_theme_copy_draft($locale, [
        'contract' => ZEROY_THEME_COPY_VERSION_CONTRACT,
        'nodes' => $base,
    ], $expected_revision);
}

function zeroy_runtime_write_versioned_document(
    int $object_id,
    string $locale,
    string $schema_id,
    string $route,
    array $document,
    int $expected_revision,
    bool $reserves_route,
    bool $publish = false
): array|WP_Error {
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 400);
    }
    if ($reserves_route) {
        $route = zeroy_runtime_normalize_route($route);
        if (is_wp_error($route)) {
            return $route;
        }
    } else {
        $route = '';
    }
    $definition = zeroy_runtime_document_definition($object_id, $schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $document = zeroy_runtime_validate_version_document($object_id, $document, $definition, $publish);
    if (is_wp_error($document)) {
        return $document;
    }
    $schema_hash = zeroy_runtime_version_contract_hash($object_id, $definition);
    if (is_wp_error($schema_hash)) {
        return $schema_hash;
    }
    $active_contract_hash = zeroy_runtime_active_schema_contract_hash();
    if (is_wp_error($active_contract_hash)) {
        return $active_contract_hash;
    }
    $locale_config = zeroy_runtime_locale_config($locale);
    $url_prefix = $reserves_route && is_array($locale_config) ? (string) $locale_config['urlPrefix'] : '';
    $old_head = zeroy_runtime_get_head($object_id, $locale);
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $schema_id, $route, $document, $expected_revision, $schema_hash, $url_prefix, $reserves_route, $publish, $definition, $active_contract_hash) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $active = zeroy_runtime_active_schema_row();
        if (!is_array($active) || !hash_equals($active_contract_hash, (string) $active['contract_hash'])) {
            return zeroy_runtime_error('zeroy_schema_changed', 'ThemeSchema changed while this content mutation was being prepared. Refresh and retry.', 409);
        }
        $head = zeroy_runtime_locked_head($object_id, $locale);
        $current_revision = $head === null ? 0 : (int) $head['revision'];
        if ($current_revision !== $expected_revision) {
            return zeroy_runtime_error('zeroy_locale_conflict', 'LocaleHead changed after it was read.', 409, ['currentRevision' => $current_revision]);
        }
        if ($head !== null && $head['schema_id'] !== $schema_id) {
            return zeroy_runtime_error('zeroy_schema_assignment_mismatch', 'LocaleHead ThemeSchema does not match the canonical object.', 409);
        }
        if ($reserves_route) {
            $reservation = zeroy_runtime_reserve_route($locale, $route, $object_id, $url_prefix);
            if (is_wp_error($reservation)) {
                return $reservation;
            }
        }
        $version_id = zeroy_runtime_insert_version($object_id, $locale, $schema_id, $schema_hash, $document);
        if (is_wp_error($version_id)) {
            return $version_id;
        }
        $next_revision = $current_revision + 1;
        if ($head === null) {
            $written = $wpdb->insert(
                zeroy_runtime_table('locale_heads'),
                [
                    'object_id' => $object_id,
                    'locale' => $locale,
                    'schema_id' => $schema_id,
                    'route_path' => $route,
                    'draft_version_id' => $version_id,
                    'published_version_id' => $publish ? $version_id : null,
                    'revision' => $next_revision,
                    'updated_at' => current_time('mysql', true),
                ],
                ['%d', '%s', '%s', '%s', '%d', '%d', '%d', '%s']
            );
        } else {
            $written = $wpdb->query(
                $wpdb->prepare(
                    'UPDATE ' . zeroy_runtime_table('locale_heads') . ' SET route_path = %s, draft_version_id = %d' . ($publish ? ', published_version_id = %d' : '') . ', revision = %d, updated_at = %s WHERE object_id = %d AND locale = %s AND revision = %d',
                    ...($publish
                        ? [$route, $version_id, $version_id, $next_revision, current_time('mysql', true), $object_id, $locale, $expected_revision]
                        : [$route, $version_id, $next_revision, current_time('mysql', true), $object_id, $locale, $expected_revision])
                )
            );
        }
        if ($written !== 1) {
            return zeroy_runtime_error('zeroy_locale_write_failed', $wpdb->last_error ?: 'Could not update LocaleHead.', 409);
        }
        $next_head = zeroy_runtime_get_head($object_id, $locale);
        if ($next_head === null) {
            return zeroy_runtime_error('zeroy_locale_missing', 'Written LocaleHead disappeared.', 409);
        }
        if ($publish && $object_id !== ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
            $version = zeroy_runtime_get_version($version_id);
            if ($version === null) {
                return zeroy_runtime_error('zeroy_version_missing', 'Written LocaleVersion disappeared.', 409);
            }
            zeroy_runtime_replace_search_projection($next_head, $version, $definition);
        }
        return $next_head;
    });
    if (is_wp_error($result)) {
        return $result;
    }
    zeroy_runtime_invalidate_document_cache($old_head);
    if ($reserves_route) {
        flush_rewrite_rules(false);
    }
    if ($publish && $object_id !== ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_array($canonical) && $canonical['post']->post_status !== 'publish') {
            wp_update_post(['ID' => $object_id, 'post_status' => 'publish']);
        }
    }
    return zeroy_runtime_project_head($result);
}

function zeroy_runtime_search_text(array $resolved, array $definition, string $canonical_title): array
{
    $text = [];
    $title = trim(wp_strip_all_tags((string) ($resolved['post']['title'] ?? $canonical_title)));
    $document = $resolved['nodes'];
    $title_node = $definition['titleNode'] ?? null;
    if (is_string($title_node) && isset($document[$title_node]) && trim($document[$title_node]) !== '') {
        $title = trim(wp_strip_all_tags($document[$title_node]));
    }
    foreach ($document as $node_id => $value) {
        $node = zeroy_runtime_document_node($definition, $node_id);
        if ($node !== null && $node['searchable']) {
            $plain = trim(wp_strip_all_tags($value));
            $text[] = $plain;
        }
    }
    return ['title' => $title, 'text' => trim(implode("\n", $text))];
}

function zeroy_runtime_replace_search_projection(array $head, array $version, array $definition): void
{
    if ((int) $head['object_id'] === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        return;
    }
    global $wpdb;
    $document = zeroy_runtime_decode_json((string) $version['document_json']);
    if (is_wp_error($document)) {
        $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $head['object_id'], 'locale' => $head['locale']], ['%d', '%s']);
        return;
    }
    $resolved = zeroy_runtime_resolve_locale_envelope((int) $head['object_id'], $document, $definition, true);
    if (is_wp_error($resolved)) {
        $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $head['object_id'], 'locale' => $head['locale']], ['%d', '%s']);
        return;
    }
    $post = get_post((int) $head['object_id']);
    $search = zeroy_runtime_search_text($resolved, $definition, $post instanceof WP_Post ? $post->post_title : '');
    $wpdb->replace(
        zeroy_runtime_table('search_projection'),
        [
            'object_id' => $head['object_id'],
            'locale' => $head['locale'],
            'published_version_id' => (int) $version['version_id'],
            'schema_id' => $head['schema_id'],
            'title' => $search['title'],
            'searchable_text' => $search['text'],
            'updated_at' => current_time('mysql', true),
        ],
        ['%d', '%s', '%d', '%s', '%s', '%s', '%s']
    );
}

function zeroy_runtime_publish_draft(int $object_id, string $locale, int $expected_revision): array|WP_Error
{
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    return zeroy_runtime_publish_versioned_document($object_id, $locale, $expected_revision, true);
}

function zeroy_runtime_publish_theme_copy_draft(string $locale, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_publish_versioned_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        $expected_revision,
        false
    );
}

function zeroy_runtime_publish_versioned_document(
    int $object_id,
    string $locale,
    int $expected_revision,
    bool $indexes_search
): array|WP_Error {
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 400);
    }
    $old_head = zeroy_runtime_get_head($object_id, $locale);
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $expected_revision, $indexes_search) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $head = zeroy_runtime_locked_head($object_id, $locale);
        if ($head === null) {
            return zeroy_runtime_error('zeroy_locale_missing', 'No LocaleHead exists for this canonical object and locale.', 404);
        }
        if ((int) $head['revision'] !== $expected_revision) {
            return zeroy_runtime_error('zeroy_locale_conflict', 'LocaleHead changed after it was read.', 409, ['currentRevision' => (int) $head['revision']]);
        }
        if ($head['draft_version_id'] === null) {
            return zeroy_runtime_error('zeroy_draft_missing', 'No locale draft exists to publish.', 409);
        }
        $version = zeroy_runtime_get_version((int) $head['draft_version_id']);
        $definition = zeroy_runtime_document_definition($object_id, (string) $head['schema_id']);
        if ($version === null || is_wp_error($definition)) {
            return is_wp_error($definition) ? $definition : zeroy_runtime_error('zeroy_version_missing', 'Locale draft version is missing.', 409);
        }
        $current_hash = zeroy_runtime_version_contract_hash($object_id, $definition);
        if (is_wp_error($current_hash)) {
            return $current_hash;
        }
        if (!hash_equals($current_hash, (string) $version['schema_hash'])) {
            return zeroy_runtime_error('zeroy_content_contract_changed', 'ThemeSchema or canonical WordPress/ACF source changed after this draft was written. Refresh contentTree and rewrite the draft.', 409);
        }
        $document = zeroy_runtime_decode_json((string) $version['document_json']);
        if (is_wp_error($document)) {
            return zeroy_runtime_error('zeroy_document_invalid', 'Locale draft JSON is invalid.', 409);
        }
        $document = zeroy_runtime_validate_version_document($object_id, $document, $definition, true);
        if (is_wp_error($document)) {
            return $document;
        }
        $next_revision = $expected_revision + 1;
        $updated = $wpdb->query(
            $wpdb->prepare(
                'UPDATE ' . zeroy_runtime_table('locale_heads') . ' SET published_version_id = %d, revision = %d, updated_at = %s WHERE object_id = %d AND locale = %s AND revision = %d',
                (int) $version['version_id'],
                $next_revision,
                current_time('mysql', true),
                $object_id,
                $locale,
                $expected_revision
            )
        );
        if ($updated !== 1) {
            return zeroy_runtime_error('zeroy_publish_failed', $wpdb->last_error ?: 'Could not update the published pointer.', 409);
        }
        if ($indexes_search) {
            zeroy_runtime_replace_search_projection(
                [
                    ...$head,
                    'published_version_id' => (int) $version['version_id'],
                ],
                $version,
                $definition
            );
        }
        return zeroy_runtime_get_head($object_id, $locale);
    });
    if (is_wp_error($result)) {
        return $result;
    }
    zeroy_runtime_invalidate_document_cache($old_head);
    if ($indexes_search) {
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_array($canonical) && $canonical['post']->post_status !== 'publish') {
            wp_update_post(['ID' => $object_id, 'post_status' => 'publish']);
        }
        flush_rewrite_rules(false);
    }
    return zeroy_runtime_project_head($result);
}

/**
 * A ThemeSchema change is a hard cut. Snapshots are structurally normalized by
 * deleting removed NodeIds, then copied into new immutable LocaleVersions with
 * the active schema hash. They are never rendered through an old-schema
 * compatibility decoder. Snapshots that need newly authored content remain
 * mismatched until an Agent writes that content explicitly.
 */
function zeroy_runtime_reconcile_schema_head(array $head, array $definition, bool $within_transaction = false): array
{
    $object_id = (int) $head['object_id'];
    $locale = (string) $head['locale'];
    $target_hash = zeroy_runtime_version_contract_hash($object_id, $definition);
    if (is_wp_error($target_hash)) {
        return [
            'state' => 'error',
            'objectId' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? null : $object_id,
            'scope' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? 'themeCopy' : 'canonical',
            'locale' => $locale,
            'code' => $target_hash->get_error_code(),
            'message' => $target_hash->get_error_message(),
        ];
    }
    $operation = function () use ($object_id, $locale, $definition, $target_hash) {
        global $wpdb;
        $locked = zeroy_runtime_locked_head($object_id, $locale);
        if ($locked === null) {
            return ['state' => 'missing', 'objectId' => $object_id, 'locale' => $locale];
        }
        $versions = [];
        foreach (['draft_version_id' => false, 'published_version_id' => true] as $pointer => $complete) {
            if ($locked[$pointer] === null) {
                continue;
            }
            $version_id = (int) $locked[$pointer];
            $version = zeroy_runtime_get_version($version_id);
            if ($version === null) {
                return [
                    'state' => 'corrupt',
                    'objectId' => $object_id,
                    'locale' => $locale,
                    'pointer' => $pointer,
                    'message' => "LocaleHead {$pointer} points at a missing LocaleVersion.",
                ];
            }
            $document = zeroy_runtime_decode_json((string) $version['document_json']);
            if (is_wp_error($document)) {
                return [
                    'state' => 'incompatible',
                    'objectId' => $object_id,
                    'locale' => $locale,
                    'pointer' => $pointer,
                    'violations' => [[
                        'code' => 'document_json_invalid',
                        'message' => 'Stored LocaleVersion JSON is invalid.',
                    ]],
                ];
            }
            $migration = zeroy_runtime_hard_migrate_document($document, $definition);
            $validated = zeroy_runtime_validate_version_document($object_id, $migration['document'], $definition, $complete);
            if (is_wp_error($validated)) {
                return [
                    'state' => 'incompatible',
                    'objectId' => $object_id,
                    'locale' => $locale,
                    'pointer' => $pointer,
                    'violations' => $validated->get_error_data()['violations'] ?? [[
                        'code' => $validated->get_error_code(),
                        'message' => $validated->get_error_message(),
                    ]],
                ];
            }
            $versions[$version_id] = [
                'version' => $version,
                'document' => $migration['document'],
                'removedNodeIds' => $migration['removedNodeIds'],
            ];
        }

        $replacement_ids = [];
        $removed_node_ids = [];
        $next = [
            'draft_version_id' => $locked['draft_version_id'],
            'published_version_id' => $locked['published_version_id'],
        ];
        foreach (array_keys($next) as $pointer) {
            if ($next[$pointer] === null) {
                continue;
            }
            $version_id = (int) $next[$pointer];
            $migration = $versions[$version_id];
            $version = $migration['version'];
            if (hash_equals($target_hash, (string) $version['schema_hash'])) {
                continue;
            }
            if (!isset($replacement_ids[$version_id])) {
                $replacement = zeroy_runtime_insert_version(
                    $object_id,
                    $locale,
                    (string) $locked['schema_id'],
                    $target_hash,
                    $migration['document']
                );
                if (is_wp_error($replacement)) {
                    return $replacement;
                }
                $replacement_ids[$version_id] = $replacement;
                $removed_node_ids = [...$removed_node_ids, ...$migration['removedNodeIds']];
            }
            $next[$pointer] = $replacement_ids[$version_id];
        }

        $changed = $next['draft_version_id'] !== $locked['draft_version_id'] || $next['published_version_id'] !== $locked['published_version_id'];
        if ($changed) {
            $next_revision = (int) $locked['revision'] + 1;
            $updated = $wpdb->update(
                zeroy_runtime_table('locale_heads'),
                [
                    'draft_version_id' => $next['draft_version_id'],
                    'published_version_id' => $next['published_version_id'],
                    'revision' => $next_revision,
                    'updated_at' => current_time('mysql', true),
                ],
                [
                    'object_id' => $object_id,
                    'locale' => $locale,
                    'revision' => (int) $locked['revision'],
                ],
                ['%d', '%d', '%d', '%s'],
                ['%d', '%s', '%d']
            );
            if ($updated !== 1) {
                return zeroy_runtime_error('zeroy_schema_migration_failed', $wpdb->last_error ?: 'Could not advance the migrated LocaleHead.', 409);
            }
            $locked = zeroy_runtime_get_head($object_id, $locale);
            if ($locked === null) {
                return zeroy_runtime_error('zeroy_locale_missing', 'Migrated LocaleHead disappeared.', 409);
            }
        }
        if ($locked['published_version_id'] === null || $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
            if ($object_id !== ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
                $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $object_id, 'locale' => $locale], ['%d', '%s']);
            }
        } else {
            $published = zeroy_runtime_get_version((int) $locked['published_version_id']);
            if ($published !== null) {
                zeroy_runtime_replace_search_projection($locked, $published, $definition);
            }
        }
        return [
            'state' => $changed ? 'migrated' : 'current',
            'objectId' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? null : $object_id,
            'scope' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? 'themeCopy' : 'canonical',
            'locale' => $locale,
            'revision' => (int) $locked['revision'],
            'removedNodeIds' => array_values(array_unique($removed_node_ids)),
        ];
    };
    $result = $within_transaction ? $operation() : zeroy_runtime_transaction($operation);
    if (is_wp_error($result)) {
        return [
            'state' => 'error',
            'objectId' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? null : $object_id,
            'scope' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? 'themeCopy' : 'canonical',
            'locale' => $locale,
            'message' => $result->get_error_message(),
            'code' => $result->get_error_code(),
        ];
    }
    return $result;
}

function zeroy_runtime_deploy_candidate_schema(bool $force = false): array|WP_Error
{
    $diagnostics = zeroy_runtime_candidate_schema_diagnostics();
    if (!$diagnostics['valid']) {
        return zeroy_runtime_error(
            'zeroy_schema_invalid',
            'Candidate ThemeSchema is invalid; the active snapshot was not changed.',
            409,
            ['violations' => $diagnostics['errors']]
        );
    }
    $candidate = $diagnostics['schema'];
    $contract_hash = (string) $diagnostics['contractHash'];
    $active = zeroy_runtime_active_schema_row();
    if (!$force && is_array($active) && hash_equals((string) $active['contract_hash'], $contract_hash)) {
        return [
            'contractHash' => $contract_hash,
            'state' => 'current',
            'migrated' => 0,
            'incompatible' => 0,
            'corrupt' => 0,
            'errors' => 0,
            'items' => [],
            'collectionReservations' => ['created' => 0, 'current' => 0],
        ];
    }
    global $wpdb;
    $deployment = zeroy_runtime_transaction(function () use ($wpdb, $candidate, $contract_hash) {
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $fresh_candidate = zeroy_runtime_candidate_schema_diagnostics();
        if (!$fresh_candidate['valid'] || !hash_equals($contract_hash, (string) ($fresh_candidate['contractHash'] ?? ''))) {
            return zeroy_runtime_error('zeroy_schema_candidate_changed', 'zeroy.schema.json changed while its deployment was being prepared. Retry the apply.', 409);
        }
        $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' ORDER BY object_id ASC, locale ASC', ARRAY_A);
        $items = [];
        $migrated = 0;
        foreach (is_array($heads) ? $heads : [] as $head) {
            $object_id = (int) $head['object_id'];
            $definition = $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID
                ? ($candidate['themeCopy'] ?? null)
                : ($candidate['schemas'][(string) $head['schema_id']] ?? null);
            if (!is_array($definition)) {
                $items[] = [
                    'state' => 'incompatible',
                    'objectId' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? null : $object_id,
                    'scope' => $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID ? 'themeCopy' : 'canonical',
                    'locale' => $head['locale'],
                    'violations' => [[
                        'code' => 'schema_definition_missing',
                        'message' => 'The candidate ThemeSchema removes a definition still owned by a LocaleHead.',
                    ]],
                ];
                continue;
            }
            $item = zeroy_runtime_reconcile_schema_head($head, $definition, true);
            $state = (string) ($item['state'] ?? 'error');
            if ($state === 'migrated') {
                $migrated++;
                $items[] = $item;
            } elseif ($state !== 'current') {
                $items[] = $item;
            }
        }
        $blockers = array_values(array_filter($items, static fn(array $item): bool => !in_array($item['state'] ?? null, ['current', 'migrated'], true)));
        if (count($blockers) > 0) {
            $planned = array_map(
                static fn(array $item): array => [
                    ...$item,
                    'state' => ($item['state'] ?? null) === 'migrated' ? 'would-migrate' : $item['state'],
                    'applied' => false,
                ],
                $items
            );
            return zeroy_runtime_error(
                'zeroy_schema_deployment_blocked',
                'Candidate ThemeSchema is incompatible with one or more LocaleHeads; no head or active schema was changed.',
                409,
                ['affectedHeads' => $planned, 'blockingHeads' => $blockers]
            );
        }
        $reservations = zeroy_runtime_sync_collection_route_reservations($candidate);
        if (count($reservations['conflicts']) > 0) {
            return zeroy_runtime_error(
                'zeroy_collection_route_conflict',
                'Candidate CollectionRoutes conflict with an existing route owner; the active schema was not changed.',
                409,
                [
                    'routeConflicts' => $reservations['conflicts'],
                    'affectedHeads' => array_map(static fn(array $item): array => [...$item, 'state' => 'would-migrate', 'applied' => false], $items),
                ]
            );
        }
        $written = $wpdb->replace(
            zeroy_runtime_table('schema_state'),
            [
                'singleton' => 1,
                'schema_json' => zeroy_runtime_json($candidate),
                'contract_hash' => $contract_hash,
                'activated_at' => current_time('mysql', true),
            ],
            ['%d', '%s', '%s', '%s']
        );
        if ($written === false) {
            return zeroy_runtime_error('zeroy_schema_activation_failed', $wpdb->last_error ?: 'Could not activate ThemeSchema snapshot.', 500);
        }
        return [
            'contractHash' => $contract_hash,
            'state' => 'reconciled',
            'migrated' => $migrated,
            'incompatible' => 0,
            'corrupt' => 0,
            'errors' => 0,
            'items' => array_map(static fn(array $item): array => [...$item, 'applied' => true], $items),
            'collectionReservations' => [
                'created' => $reservations['created'],
                'current' => $reservations['current'],
            ],
        ];
    });
    return $deployment;
}

function zeroy_runtime_ensure_active_schema_reconciled(): void
{
    if (zeroy_runtime_active_schema_row() === null) {
        zeroy_runtime_deploy_candidate_schema(true);
    }
}
add_action('init', 'zeroy_runtime_ensure_active_schema_reconciled', 2);

function zeroy_runtime_unpublish(int $object_id, string $locale, int $expected_revision): array|WP_Error
{
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    return zeroy_runtime_unpublish_versioned_document($object_id, $locale, $expected_revision, true);
}

function zeroy_runtime_unpublish_theme_copy(string $locale, int $expected_revision): array|WP_Error
{
    return zeroy_runtime_unpublish_versioned_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        $expected_revision,
        false
    );
}

function zeroy_runtime_unpublish_versioned_document(
    int $object_id,
    string $locale,
    int $expected_revision,
    bool $indexes_search
): array|WP_Error {
    $old_head = zeroy_runtime_get_head($object_id, $locale);
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $expected_revision, $indexes_search) {
        global $wpdb;
        $lease = zeroy_runtime_acquire_schema_lease();
        if (is_wp_error($lease)) {
            return $lease;
        }
        $head = zeroy_runtime_locked_head($object_id, $locale);
        if ($head === null) {
            return zeroy_runtime_error('zeroy_locale_missing', 'No LocaleHead exists for this canonical object and locale.', 404);
        }
        if ((int) $head['revision'] !== $expected_revision) {
            return zeroy_runtime_error('zeroy_locale_conflict', 'LocaleHead changed after it was read.', 409, ['currentRevision' => (int) $head['revision']]);
        }
        $next_revision = $expected_revision + 1;
        $updated = $wpdb->query(
            $wpdb->prepare(
                'UPDATE ' . zeroy_runtime_table('locale_heads') . ' SET published_version_id = NULL, revision = %d, updated_at = %s WHERE object_id = %d AND locale = %s AND revision = %d',
                $next_revision,
                current_time('mysql', true),
                $object_id,
                $locale,
                $expected_revision
            )
        );
        if ($updated !== 1) {
            return zeroy_runtime_error('zeroy_unpublish_failed', $wpdb->last_error ?: 'Could not clear the published pointer.', 409);
        }
        if ($indexes_search) {
            $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $object_id, 'locale' => $locale], ['%d', '%s']);
        }
        return zeroy_runtime_get_head($object_id, $locale);
    });
    if (is_wp_error($result)) {
        return $result;
    }
    zeroy_runtime_invalidate_document_cache($old_head);
    if ($indexes_search) {
        flush_rewrite_rules(false);
    }
    return zeroy_runtime_project_head($result);
}

function zeroy_runtime_project_head(array $head, bool $include_documents = false): array
{
    $object_id = (int) $head['object_id'];
    $theme_copy = $object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID;
    $draft = $head['draft_version_id'] === null ? null : zeroy_runtime_get_version((int) $head['draft_version_id']);
    $published = $head['published_version_id'] === null ? null : zeroy_runtime_get_version((int) $head['published_version_id']);
    $definition = zeroy_runtime_document_definition($object_id, (string) $head['schema_id']);
    $contract_hash = is_array($definition) ? zeroy_runtime_version_contract_hash($object_id, $definition) : null;
    $schema_hash = is_string($contract_hash) ? $contract_hash : null;
    $published_matches = $published !== null && $schema_hash !== null && hash_equals($schema_hash, (string) $published['schema_hash']);
    $content_review = null;
    if ($published !== null && !$published_matches) {
        $violations = [];
        if (is_array($definition)) {
            $document = zeroy_runtime_decode_json((string) $published['document_json']);
            $violations = is_wp_error($document)
                ? [[
                    'code' => 'document_json_invalid',
                    'message' => 'Stored published LocaleVersion JSON is invalid.',
                ]]
                : ($theme_copy
                    ? zeroy_runtime_document_violations(is_array($document['nodes'] ?? null) ? $document['nodes'] : [], $definition, true)
                    : zeroy_runtime_locale_envelope_violations($document, $definition, $object_id, true));
        } elseif (is_wp_error($definition)) {
            $violations = [[
                'code' => $definition->get_error_code(),
                'message' => $definition->get_error_message(),
            ]];
        }
        $content_review = [
            'required' => true,
            'publishedSchemaHash' => $published['schema_hash'],
            'activeSchemaHash' => $schema_hash,
            'violations' => $violations,
        ];
    }
    $locale_enabled = zeroy_runtime_locale_is_enabled((string) $head['locale']);
    $stale_decision = is_array($content_review) && count(array_filter(
        $content_review['violations'],
        static fn(array $violation): bool => in_array($violation['code'] ?? null, ['decision_stale', 'decision_unresolved'], true)
    )) > 0;
    $state = !$locale_enabled
        ? 'disabled'
        : ($published === null ? ($draft === null ? 'not-started' : 'draft') : ($published_matches ? 'published' : ($stale_decision ? 'content-stale' : 'schema-mismatch')));
    $projected = [
        'scope' => $theme_copy ? 'themeCopy' : 'canonical',
        'objectId' => $theme_copy ? null : $object_id,
        'locale' => $head['locale'],
        'schemaId' => $head['schema_id'],
        'contractHash' => $schema_hash,
        'route' => $theme_copy ? null : $head['route_path'],
        'url' => !$theme_copy && $locale_enabled ? zeroy_runtime_route_url((string) $head['locale'], (string) $head['route_path']) : null,
        'revision' => (int) $head['revision'],
        'draftVersionId' => $head['draft_version_id'] === null ? null : (int) $head['draft_version_id'],
        'draftPreviewUrl' => $theme_copy || $head['draft_version_id'] === null
            ? null
            : zeroy_runtime_preview_url($object_id, (string) $head['locale'], (int) $head['draft_version_id']),
        'publishedVersionId' => $head['published_version_id'] === null ? null : (int) $head['published_version_id'],
        'state' => $state,
        'contractMatchesPublished' => $published === null ? null : $published_matches,
        'contentReview' => $content_review,
    ];
    if ($include_documents) {
        $projected['draft'] = $draft === null ? null : [
            'versionId' => (int) $draft['version_id'],
            'contractHash' => $draft['schema_hash'],
            'document' => zeroy_runtime_decode_json((string) $draft['document_json']),
            'createdAt' => $draft['created_at'],
        ];
        $projected['published'] = $published === null ? null : [
            'versionId' => (int) $published['version_id'],
            'contractHash' => $published['schema_hash'],
            'document' => zeroy_runtime_decode_json((string) $published['document_json']),
            'createdAt' => $published['created_at'],
        ];
    }
    return $projected;
}

function zeroy_runtime_read_document(int $object_id, string $locale, string $schema_id): array|WP_Error
{
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', 'This locale is not enabled.', 404);
    }
    $head = zeroy_runtime_get_head($object_id, $locale);
    if ($head === null || $head['schema_id'] !== $schema_id || $head['published_version_id'] === null) {
        return zeroy_runtime_error('zeroy_locale_not_published', 'Locale document is not published.', 404);
    }
    $definition = zeroy_runtime_document_definition($object_id, $schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $version = zeroy_runtime_get_version((int) $head['published_version_id']);
    $contract_hash = zeroy_runtime_version_contract_hash($object_id, $definition);
    if ($version === null || is_wp_error($contract_hash)) {
        return zeroy_runtime_error('zeroy_schema_mismatch', 'Published locale version does not match the active content contract.', 404);
    }
    if (!hash_equals($contract_hash, (string) $version['schema_hash'])) {
        $stored = zeroy_runtime_decode_json((string) $version['document_json']);
        $violations = !is_wp_error($stored) && $object_id !== ZEROY_RUNTIME_THEME_COPY_OBJECT_ID
            ? zeroy_runtime_locale_envelope_violations($stored, $definition, $object_id, true)
            : [];
        $content_stale = count(array_filter(
            $violations,
            static fn(array $violation): bool => in_array($violation['code'] ?? null, ['decision_stale', 'decision_unresolved'], true)
        )) > 0;
        return $content_stale
            ? zeroy_runtime_error('zeroy_content_stale', 'Canonical WordPress/ACF content changed; refresh contentTree and review locale decisions.', 409, ['violations' => $violations])
            : zeroy_runtime_error('zeroy_schema_mismatch', 'Published locale version does not match the active ThemeSchema.', 404);
    }
    $cache_key = zeroy_runtime_document_cache_key($object_id, $locale, (int) $version['version_id'], (string) $version['schema_hash']);
    $cached = wp_cache_get($cache_key, 'zeroy-runtime');
    if (is_array($cached)) {
        return $cached;
    }
    $document = zeroy_runtime_decode_json((string) $version['document_json']);
    if (is_wp_error($document)) {
        return zeroy_runtime_error('zeroy_document_invalid', 'Published locale document is invalid.', 404);
    }
    if ($object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        $document = zeroy_runtime_validate_version_document($object_id, $document, $definition, true);
        if (is_wp_error($document)) {
            return $document;
        }
        $resolved = $document['nodes'];
    } else {
        $resolved = zeroy_runtime_resolve_locale_envelope($object_id, $document, $definition, true);
        if (is_wp_error($resolved)) {
            return $resolved;
        }
    }
    wp_cache_set($cache_key, $resolved, 'zeroy-runtime');
    return $resolved;
}

function zeroy_locale_content(int $object_id, string $locale, string $schema_id): array
{
    $override = $GLOBALS['zeroy_runtime_document_override'] ?? null;
    if (
        is_array($override) &&
        $override['objectId'] === $object_id &&
        $override['locale'] === $locale &&
        $override['schemaId'] === $schema_id &&
        is_array($override['document'] ?? null)
    ) {
        return $override['document'];
    }
    $document = zeroy_runtime_read_document($object_id, $locale, $schema_id);
    if (is_wp_error($document)) {
        wp_die($document->get_error_message(), 'zeroY locale document unavailable', ['response' => 404]);
    }
    return $document;
}

function zeroy_theme_copy_document(string $locale): array
{
    $document = zeroy_runtime_read_document(
        ZEROY_RUNTIME_THEME_COPY_OBJECT_ID,
        $locale,
        ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID
    );
    if (is_wp_error($document)) {
        wp_die($document->get_error_message(), 'zeroY theme copy unavailable', ['response' => 404]);
    }
    return $document;
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

function zeroy_runtime_preview_token(int $object_id, string $locale, int $version_id): string
{
    return hash_hmac('sha256', implode(':', [$object_id, $locale, $version_id]), zeroy_runtime_connection_key());
}

function zeroy_runtime_preview_url(int $object_id, string $locale, int $version_id): string
{
    return add_query_arg([
        'zeroy_preview' => '1',
        'objectId' => $object_id,
        'locale' => $locale,
        'versionId' => $version_id,
        'token' => zeroy_runtime_preview_token($object_id, $locale, $version_id),
    ], home_url('/'));
}

function zeroy_runtime_published_locale_links(int $object_id, string $schema_id): array
{
    $links = [];
    foreach (zeroy_runtime_heads_for_object($object_id) as $head) {
        if ($head['schema_id'] !== $schema_id || $head['published_version_id'] === null || !zeroy_runtime_locale_is_enabled((string) $head['locale'])) {
            continue;
        }
        $document = zeroy_runtime_read_document($object_id, (string) $head['locale'], $schema_id);
        if (is_wp_error($document)) {
            continue;
        }
        $links[] = ['locale' => $head['locale'], 'url' => zeroy_runtime_route_url((string) $head['locale'], (string) $head['route_path'])];
    }
    return $links;
}

function zeroy_locale_links(string $route): array
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    if (!is_array($context)) {
        return [];
    }
    if (($context['kind'] ?? null) === 'collection') {
        return is_array($context['links'] ?? null) ? $context['links'] : [];
    }
    $links = [];
    foreach (zeroy_runtime_published_locale_links((int) $context['objectId'], (string) $context['schemaId']) as $link) {
        $links[] = ['locale' => $link['locale'], 'available' => true, 'url' => $link['url']];
    }
    return $links;
}

function zeroy_current_locale(): string
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    return is_array($context) ? (string) $context['locale'] : '';
}

function zeroy_collection_context(): array|WP_Error
{
    $context = $GLOBALS['zeroy_runtime_route_context'] ?? null;
    return is_array($context) && ($context['kind'] ?? null) === 'collection'
        ? $context
        : zeroy_runtime_error('zeroy_collection_context_missing', 'The current request is not a zeroY CollectionRoute.', 409);
}

function zeroy_runtime_projection_select(array $select): array|WP_Error
{
    if (!array_is_list($select) || count($select) === 0 || count($select) > 50) {
        return zeroy_runtime_error('zeroy_entity_select_invalid', 'select must contain between 1 and 50 JSON pointers.', 400);
    }
    $normalized = [];
    foreach ($select as $pointer) {
        if ($pointer === 'url') {
            $normalized['url'] = null;
            continue;
        }
        if (!is_string($pointer) || !preg_match('#\A/(?:post|acf|nodes)(?:/[^/]+)+\z#', $pointer)) {
            return zeroy_runtime_error('zeroy_entity_select_invalid', 'Each selector must be url or a JSON pointer rooted at /post, /acf or /nodes.', 400, ['selector' => $pointer]);
        }
        $parts = zeroy_runtime_pointer_parts($pointer);
        if (is_wp_error($parts)) {
            return $parts;
        }
        $normalized[$pointer] = $parts;
    }
    return $normalized;
}

function zeroy_runtime_nested_value(array $root, array $parts, bool &$found): mixed
{
    $cursor = $root;
    foreach ($parts as $part) {
        if (!is_array($cursor) || !array_key_exists($part, $cursor)) {
            $found = false;
            return null;
        }
        $cursor = $cursor[$part];
    }
    $found = true;
    return $cursor;
}

function zeroy_runtime_projection_set(array &$root, array $parts, mixed $value): void
{
    $cursor =& $root;
    foreach ($parts as $index => $part) {
        if ($index === count($parts) - 1) {
            $cursor[$part] = $value;
            return;
        }
        if (!isset($cursor[$part]) || !is_array($cursor[$part])) {
            $cursor[$part] = [];
        }
        $cursor =& $cursor[$part];
    }
}

/**
 * Explicit resolved projection for collection cards and relationship targets.
 * Canonical relationship leaves remain IDs; callers opt into locale resolution
 * and a bounded field selection at this boundary.
 */
function zeroy_locale_entities(
    array $object_ids,
    string $locale,
    array $select = ['url', '/post/title']
): array|WP_Error {
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', 'This locale is not enabled.', 404);
    }
    if (!array_is_list($object_ids) || count($object_ids) === 0 || count($object_ids) > 100) {
        return zeroy_runtime_error('zeroy_entity_ids_invalid', 'objectIds must contain between 1 and 100 IDs.', 400);
    }
    $ids = [];
    foreach ($object_ids as $object_id) {
        if (!is_int($object_id) && !(is_string($object_id) && ctype_digit($object_id))) {
            return zeroy_runtime_error('zeroy_entity_ids_invalid', 'Every objectId must be a positive integer.', 400);
        }
        $object_id = (int) $object_id;
        if ($object_id < 1) {
            return zeroy_runtime_error('zeroy_entity_ids_invalid', 'Every objectId must be a positive integer.', 400);
        }
        $ids[$object_id] = $object_id;
    }
    $ids = array_values($ids);
    $selectors = zeroy_runtime_projection_select($select);
    if (is_wp_error($selectors)) {
        return $selectors;
    }
    if (function_exists('_prime_post_caches')) {
        _prime_post_caches($ids, true, true);
    }
    global $wpdb;
    $placeholders = implode(', ', array_fill(0, count($ids), '%d'));
    $rows = $wpdb->get_results(
        $wpdb->prepare(
            'SELECT object_id, schema_id, route_path, published_version_id FROM ' . zeroy_runtime_table('locale_heads') . " WHERE locale = %s AND published_version_id IS NOT NULL AND object_id IN ({$placeholders})",
            $locale,
            ...$ids
        ),
        ARRAY_A
    );
    $heads = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $heads[(int) $row['object_id']] = $row;
    }
    $items = [];
    $unavailable = [];
    foreach ($ids as $object_id) {
        $head = $heads[$object_id] ?? null;
        if (!is_array($head)) {
            $unavailable[] = ['objectId' => $object_id, 'code' => 'not-published'];
            continue;
        }
        $resolved = zeroy_runtime_read_document($object_id, $locale, (string) $head['schema_id']);
        if (is_wp_error($resolved)) {
            $unavailable[] = [
                'objectId' => $object_id,
                'code' => $resolved->get_error_code(),
                'message' => $resolved->get_error_message(),
            ];
            continue;
        }
        $fields = [];
        foreach ($selectors as $selector => $parts) {
            if ($selector === 'url') {
                continue;
            }
            $found = false;
            $value = zeroy_runtime_nested_value($resolved, $parts, $found);
            if ($found) {
                zeroy_runtime_projection_set($fields, $parts, $value);
            }
        }
        $items[] = [
            'objectId' => $object_id,
            'locale' => $locale,
            'schemaId' => $head['schema_id'],
            'route' => $head['route_path'],
            ...(array_key_exists('url', $selectors) ? ['url' => zeroy_runtime_route_url($locale, (string) $head['route_path'])] : []),
            'publishedVersionId' => (int) $head['published_version_id'],
            'fields' => $fields,
        ];
    }
    return ['items' => $items, 'unavailable' => $unavailable];
}

function zeroy_collection_items(
    array $select = ['url', '/post/title'],
    int $page = 1,
    int $per_page = 12
): array|WP_Error {
    $context = zeroy_collection_context();
    if (is_wp_error($context)) {
        return $context;
    }
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    global $wpdb;
    $ids = $wpdb->get_col(
        $wpdb->prepare(
            'SELECT object_id FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE locale = %s AND schema_id = %s AND published_version_id IS NOT NULL ORDER BY object_id DESC',
            $context['locale'],
            $context['schemaId']
        )
    );
    $ids = array_map('intval', is_array($ids) ? $ids : []);
    if (($context['collectionKind'] ?? null) === 'taxonomy') {
        $term = $context['term'] ?? null;
        $assigned = $term instanceof WP_Term
            ? get_objects_in_term($term->term_id, $term->taxonomy)
            : [];
        $assigned_ids = array_fill_keys(array_map('intval', is_wp_error($assigned) ? [] : $assigned), true);
        $ids = array_values(array_filter($ids, static fn(int $id): bool => isset($assigned_ids[$id])));
    }
    $total = count($ids);
    $page_ids = array_slice($ids, ($page - 1) * $per_page, $per_page);
    if (count($page_ids) === 0) {
        return ['items' => [], 'unavailable' => [], 'page' => $page, 'perPage' => $per_page, 'total' => $total];
    }
    $projection = zeroy_locale_entities($page_ids, (string) $context['locale'], $select);
    return is_wp_error($projection)
        ? $projection
        : [...$projection, 'page' => $page, 'perPage' => $per_page, 'total' => $total];
}

function zeroy_locale_archive(string $locale, string $schema_id, int $page = 1, int $per_page = 10): array|WP_Error
{
    return zeroy_runtime_search_or_archive($locale, $schema_id, null, $page, $per_page);
}

function zeroy_locale_search(string $locale, string $schema_id, string $query, int $page = 1, int $per_page = 10): array|WP_Error
{
    return zeroy_runtime_search_or_archive($locale, $schema_id, $query, $page, $per_page);
}

function zeroy_runtime_search_or_archive(string $locale, string $schema_id, ?string $query, int $page, int $per_page): array|WP_Error
{
    global $wpdb;
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', 'This locale is not enabled.', 404);
    }
    $definition = zeroy_runtime_schema_definition($schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $heads = zeroy_runtime_table('locale_heads');
    $search = zeroy_runtime_table('search_projection');
    $where = 'h.locale = %s AND h.schema_id = %s AND h.published_version_id = p.published_version_id';
    $arguments = [$locale, $schema_id];
    if ($query !== null && trim($query) !== '') {
        $where .= ' AND (p.title LIKE %s OR p.searchable_text LIKE %s)';
        $like = '%' . $wpdb->esc_like(trim($query)) . '%';
        $arguments[] = $like;
        $arguments[] = $like;
    }
    $from = " FROM {$heads} h JOIN {$search} p ON p.object_id = h.object_id AND p.locale = h.locale";
    $rows = $wpdb->get_results(
        $wpdb->prepare('SELECT h.object_id, h.locale, h.route_path, h.schema_id, h.published_version_id, p.title' . $from . ' WHERE ' . $where . ' ORDER BY h.object_id DESC', ...$arguments),
        ARRAY_A
    );
    $current = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        if (is_wp_error(zeroy_runtime_read_document((int) $row['object_id'], (string) $row['locale'], (string) $row['schema_id']))) {
            continue;
        }
        $current[] = [
            'objectId' => (int) $row['object_id'],
            'locale' => $row['locale'],
            'schemaId' => $row['schema_id'],
            'route' => $row['route_path'],
            'url' => zeroy_runtime_route_url($row['locale'], $row['route_path']),
            'publishedVersionId' => (int) $row['published_version_id'],
            'title' => $row['title'],
        ];
    }
    $total = count($current);
    $items = array_slice($current, ($page - 1) * $per_page, $per_page);
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $total];
}

function zeroy_runtime_inventory(int $page = 1, int $per_page = 50): array
{
    global $wpdb;
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $offset = ($page - 1) * $per_page;
    $meta = ZEROY_RUNTIME_SCHEMA_META;
    $count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . $wpdb->postmeta . ' WHERE meta_key = %s', $meta));
    $objects = $wpdb->get_results(
        $wpdb->prepare(
            'SELECT p.ID, p.post_type, p.post_status, p.post_title, schema_meta.meta_value AS schema_id, revision_meta.meta_value AS revision FROM ' . $wpdb->posts . ' p JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s LEFT JOIN ' . $wpdb->postmeta . ' revision_meta ON revision_meta.post_id = p.ID AND revision_meta.meta_key = %s ORDER BY p.ID DESC LIMIT %d OFFSET %d',
            $meta,
            ZEROY_RUNTIME_CANONICAL_REVISION_META,
            $per_page,
            $offset
        ),
        ARRAY_A
    );
    $config = zeroy_runtime_site_config();
    $enabled = is_array($config) ? $config['enabledLocales'] : [];
    $items = [];
    foreach (is_array($objects) ? $objects : [] as $object) {
        $object_id = (int) $object['ID'];
        $heads = [];
        foreach (zeroy_runtime_heads_for_object($object_id) as $head) {
            $heads[$head['locale']] = zeroy_runtime_project_head($head);
        }
        foreach ($enabled as $locale) {
            if (!isset($heads[$locale['locale']])) {
                $heads[$locale['locale']] = [
                    'objectId' => $object_id,
                    'locale' => $locale['locale'],
                    'schemaId' => $object['schema_id'],
                    'route' => null,
                    'url' => null,
                    'revision' => 0,
                    'draftVersionId' => null,
                    'publishedVersionId' => null,
                    'state' => 'not-started',
                    'contractMatchesPublished' => null,
                ];
            }
        }
        ksort($heads, SORT_STRING);
        $items[] = [
            'objectId' => $object_id,
            'postType' => $object['post_type'],
            'postStatus' => $object['post_status'],
            'postTitle' => $object['post_title'],
            'schemaId' => $object['schema_id'],
            'revision' => (int) $object['revision'],
            'locales' => array_values($heads),
        ];
    }
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $count];
}

function zeroy_runtime_acf_field_projection(array $field): array
{
    $projected = [
        'key' => (string) ($field['key'] ?? ''),
        'name' => (string) ($field['name'] ?? ''),
        'label' => (string) ($field['label'] ?? ''),
        'type' => (string) ($field['type'] ?? ''),
        'required' => (bool) ($field['required'] ?? false),
    ];
    $choices = $field['choices'] ?? null;
    if (is_array($choices) && in_array($projected['type'], ['checkbox', 'radio', 'select', 'button_group'], true)) {
        $projected_choices = [];
        foreach ($choices as $value => $label) {
            if (is_array($label)) {
                foreach ($label as $nested_value => $nested_label) {
                    $projected_choices[] = [
                        'value' => (string) $nested_value,
                        'label' => (string) $nested_label,
                    ];
                }
                continue;
            }
            $projected_choices[] = [
                'value' => (string) $value,
                'label' => (string) $label,
            ];
        }
        $projected['choices'] = $projected_choices;
    }
    $children = $field['sub_fields'] ?? [];
    if (is_array($children) && count($children) > 0) {
        $projected['children'] = array_map('zeroy_runtime_acf_field_projection', $children);
    }
    return $projected;
}

function zeroy_runtime_acf_projection(): array
{
    if (!function_exists('acf_get_field_groups') || !function_exists('acf_get_fields')) {
        return ['available' => false, 'fieldGroups' => []];
    }
    $groups = [];
    foreach (acf_get_field_groups() as $group) {
        $fields = acf_get_fields($group);
        $groups[] = [
            'key' => (string) ($group['key'] ?? ''),
            'title' => (string) ($group['title'] ?? ''),
            'location' => $group['location'] ?? [],
            'fields' => is_array($fields) ? array_map('zeroy_runtime_acf_field_projection', $fields) : [],
        ];
    }
    return ['available' => true, 'fieldGroups' => $groups];
}

function zeroy_runtime_integrity(): array
{
    global $wpdb;
    $issues = [];
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        $issues[] = ['code' => $config->get_error_code(), 'message' => $config->get_error_message()];
    }
    $schema_diagnostics = zeroy_runtime_schema_diagnostics();
    foreach ($schema_diagnostics['errors'] as $error) {
        $issues[] = $error;
    }
    $candidate_diagnostics = zeroy_runtime_candidate_schema_diagnostics();
    foreach ($candidate_diagnostics['errors'] as $error) {
        $issues[] = ['scope' => 'themeSchemaCandidate', ...$error];
    }
    if (
        $schema_diagnostics['valid'] &&
        $candidate_diagnostics['valid'] &&
        !hash_equals((string) $schema_diagnostics['contractHash'], (string) $candidate_diagnostics['contractHash'])
    ) {
        $issues[] = [
            'code' => 'schema_candidate_not_active',
            'scope' => 'themeSchemaCandidate',
            'activeContractHash' => $schema_diagnostics['contractHash'],
            'candidateContractHash' => $candidate_diagnostics['contractHash'],
            'message' => 'zeroy.schema.json differs from the active transactional ThemeSchema snapshot. Apply it through the Connector or restore the active source.',
        ];
    }
    $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads'), ARRAY_A);
    foreach (is_array($heads) ? $heads : [] as $head) {
        $theme_copy = (int) $head['object_id'] === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID;
        if ($theme_copy) {
            if ((string) $head['schema_id'] !== ZEROY_RUNTIME_THEME_COPY_SCHEMA_ID) {
                $issues[] = ['code' => 'theme_copy_schema_invalid', 'locale' => $head['locale'], 'message' => 'ThemeCopy LocaleHead does not use the reserved ThemeCopy schema.'];
            }
        } else {
            $reservation = $wpdb->get_var(
                $wpdb->prepare('SELECT object_id FROM ' . zeroy_runtime_table('route_reservations') . ' WHERE locale = %s AND route_path = %s', $head['locale'], $head['route_path'])
            );
            if ((int) $reservation !== (int) $head['object_id']) {
                $issues[] = ['code' => 'route_reservation_missing', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'message' => 'LocaleHead route is not reserved by its canonical object.'];
            }
        }
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] !== null && zeroy_runtime_get_version((int) $head[$pointer]) === null) {
                $issues[] = ['code' => 'version_pointer_missing', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'message' => "LocaleHead {$pointer} points at a missing LocaleVersion."];
            }
        }
        if ($head['published_version_id'] !== null) {
            $head_projection = zeroy_runtime_project_head($head);
            if (in_array($head_projection['state'], ['content-stale', 'schema-mismatch'], true)) {
                $issues[] = [
                    'code' => $head_projection['state'],
                    'scope' => $theme_copy ? 'themeCopy' : 'canonical',
                    'objectId' => $theme_copy ? null : (int) $head['object_id'],
                    'locale' => $head['locale'],
                    'message' => $theme_copy
                        ? 'Published ThemeCopy no longer matches the active ThemeSchema.'
                        : 'Published locale content no longer matches its current ThemeSchema or canonical source.',
                    'review' => $head_projection['contentReview'],
                ];
            }
        }
        if (!$theme_copy && $head['published_version_id'] !== null) {
            $projection = $wpdb->get_row(
                $wpdb->prepare('SELECT published_version_id FROM ' . zeroy_runtime_table('search_projection') . ' WHERE object_id = %d AND locale = %s', $head['object_id'], $head['locale']),
                ARRAY_A
            );
            if (!is_array($projection) || (int) $projection['published_version_id'] !== (int) $head['published_version_id']) {
                $issues[] = ['code' => 'search_projection_mismatch', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'message' => 'Search projection does not reference the published pointer.'];
            }
        }
    }
    return ['ok' => count($issues) === 0, 'issues' => $issues, 'checkedAt' => current_time('mysql', true)];
}

function zeroy_runtime_install_schema(): void
{
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset = $wpdb->get_charset_collate();
    $tables = [
        'runtime_locks' => "CREATE TABLE " . zeroy_runtime_table('runtime_locks') . " (
            lock_name VARCHAR(64) NOT NULL,
            revision BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (lock_name)
        ) {$charset};",
        'schema_state' => "CREATE TABLE " . zeroy_runtime_table('schema_state') . " (
            singleton TINYINT UNSIGNED NOT NULL,
            schema_json LONGTEXT NOT NULL,
            contract_hash CHAR(64) NOT NULL,
            activated_at DATETIME NOT NULL,
            PRIMARY KEY (singleton)
        ) {$charset};",
        'site_config' => "CREATE TABLE " . zeroy_runtime_table('site_config') . " (
            singleton TINYINT UNSIGNED NOT NULL,
            config_json LONGTEXT NOT NULL,
            revision BIGINT UNSIGNED NOT NULL,
            PRIMARY KEY (singleton)
        ) {$charset};",
        'locale_versions' => "CREATE TABLE " . zeroy_runtime_table('locale_versions') . " (
            version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            object_id BIGINT UNSIGNED NOT NULL,
            locale VARCHAR(32) NOT NULL,
            schema_id VARCHAR(96) NOT NULL,
            schema_hash CHAR(64) NOT NULL,
            document_json LONGTEXT NOT NULL,
            created_at DATETIME NOT NULL,
            PRIMARY KEY (version_id),
            KEY zeroy_version_object_locale (object_id, locale)
        ) {$charset};",
        'locale_heads' => "CREATE TABLE " . zeroy_runtime_table('locale_heads') . " (
            object_id BIGINT UNSIGNED NOT NULL,
            locale VARCHAR(32) NOT NULL,
            schema_id VARCHAR(96) NOT NULL,
            route_path VARCHAR(190) NOT NULL,
            url_prefix VARCHAR(80) NOT NULL,
            draft_version_id BIGINT UNSIGNED NULL,
            published_version_id BIGINT UNSIGNED NULL,
            revision BIGINT UNSIGNED NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (object_id, locale),
            KEY zeroy_head_published (published_version_id),
            KEY zeroy_head_route (locale, route_path)
        ) {$charset};",
        'route_reservations' => "CREATE TABLE " . zeroy_runtime_table('route_reservations') . " (
            locale VARCHAR(32) NOT NULL,
            route_path VARCHAR(190) NOT NULL,
            object_id BIGINT UNSIGNED NOT NULL,
            reserved_at DATETIME NOT NULL,
            PRIMARY KEY (locale, route_path),
            KEY zeroy_reservation_object (object_id)
        ) {$charset};",
        'collection_route_reservations' => "CREATE TABLE " . zeroy_runtime_table('collection_route_reservations') . " (
            locale VARCHAR(32) NOT NULL,
            route_path VARCHAR(190) NOT NULL,
            url_prefix VARCHAR(80) NOT NULL,
            collection_id VARCHAR(96) NOT NULL,
            kind VARCHAR(32) NOT NULL,
            reserved_at DATETIME NOT NULL,
            PRIMARY KEY (locale, route_path),
            KEY zeroy_collection_identity (collection_id)
        ) {$charset};",
        'search_projection' => "CREATE TABLE " . zeroy_runtime_table('search_projection') . " (
            object_id BIGINT UNSIGNED NOT NULL,
            locale VARCHAR(32) NOT NULL,
            published_version_id BIGINT UNSIGNED NOT NULL,
            schema_id VARCHAR(96) NOT NULL,
            title TEXT NOT NULL,
            searchable_text LONGTEXT NOT NULL,
            updated_at DATETIME NOT NULL,
            PRIMARY KEY (object_id, locale),
            KEY zeroy_search_version (published_version_id),
            KEY zeroy_search_schema_locale (schema_id, locale)
        ) {$charset};",
    ];
    foreach ($tables as $name => $sql) {
        $table = zeroy_runtime_table($name);
        $exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table));
        if ($exists === $table) {
            continue;
        }
        dbDelta($sql);
    }
    $locks = zeroy_runtime_table('runtime_locks');
    if ($wpdb->get_var("SELECT lock_name FROM {$locks} WHERE lock_name = 'schema-deployment'") === null) {
        $wpdb->insert($locks, ['lock_name' => 'schema-deployment', 'revision' => 0], ['%s', '%d']);
    }
    $reservations = zeroy_runtime_table('route_reservations');
    $columns = $wpdb->get_results("SHOW COLUMNS FROM {$reservations}", ARRAY_A);
    $has_prefix = false;
    foreach (is_array($columns) ? $columns : [] as $column) {
        if (($column['Field'] ?? null) === 'url_prefix') {
            $has_prefix = true;
            break;
        }
    }
    if (!$has_prefix) {
        $wpdb->query("ALTER TABLE {$reservations} ADD COLUMN url_prefix VARCHAR(80) NOT NULL DEFAULT ''");
    }
}

function zeroy_runtime_maybe_upgrade(): void
{
    if (get_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, '') === ZEROY_RUNTIME_DATABASE_VERSION) {
        return;
    }
    zeroy_runtime_install_schema();
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
}

function zeroy_runtime_activate(): void
{
    zeroy_runtime_install_schema();
    zeroy_runtime_site_id();
    zeroy_runtime_connection_key();
    zeroy_runtime_ensure_site_config();
    zeroy_runtime_deploy_candidate_schema(true);
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
    flush_rewrite_rules(false);
}

function zeroy_runtime_deactivate(): void
{
    flush_rewrite_rules(false);
}
