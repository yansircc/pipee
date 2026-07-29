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
    $route = trim(wp_normalize_path($route), '/');
    if ($route === '' || !preg_match('/\A[a-z0-9][a-z0-9\-\/]*\z/i', $route)) {
        return zeroy_runtime_error('zeroy_invalid_route', 'Route must contain path-safe letters, digits, hyphens, and slashes.', 400);
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
    flush_rewrite_rules(false);
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

function zeroy_runtime_schema_diagnostics(): array
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
    $validated = zeroy_runtime_validate_theme_schema($schema);
    if (is_wp_error($validated)) {
        return ['valid' => false, 'errors' => [['code' => $validated->get_error_code(), 'message' => $validated->get_error_message()]]];
    }
    return [
        'valid' => true,
        'schema' => $validated,
        'contractHash' => zeroy_runtime_hash($validated),
        'schemaHashes' => zeroy_runtime_schema_hashes($validated),
        'errors' => [],
    ];
}

function zeroy_runtime_validate_theme_schema(array $schema): array|WP_Error
{
    if (($schema['contract'] ?? null) !== ZEROY_THEME_SCHEMA_CONTRACT || !is_array($schema['schemas'] ?? null) || array_is_list($schema['schemas'])) {
        return zeroy_runtime_error('zeroy_schema_invalid', 'ThemeSchema requires contract and a schemas object.', 409);
    }
    $normalized = ['contract' => ZEROY_THEME_SCHEMA_CONTRACT, 'schemas' => []];
    foreach ($schema['schemas'] as $schema_id => $definition) {
        if (!is_string($schema_id) || !preg_match('/\A[a-z][a-z0-9-]{0,95}\z/', $schema_id) || !is_array($definition)) {
            return zeroy_runtime_error('zeroy_schema_invalid', 'ThemeSchema has an invalid schemaId.', 409);
        }
        $label = trim((string) ($definition['label'] ?? ''));
        $template = $definition['template'] ?? null;
        $post_types = $definition['canonicalPostTypes'] ?? null;
        $nodes = $definition['nodes'] ?? null;
        if ($label === '' || !is_string($template) || $template === '' || !is_array($post_types) || !array_is_list($post_types) || count($post_types) === 0 || !is_array($nodes) || array_is_list($nodes)) {
            return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} needs label, template, canonicalPostTypes and nodes.", 409);
        }
        $template = ltrim(wp_normalize_path($template), '/');
        if (str_contains($template, '..') || !preg_match('/\A[a-zA-Z0-9_\-\/]+\.php\z/', $template) || !is_file(get_stylesheet_directory() . '/' . $template)) {
            return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} references a missing or unsafe template.", 409);
        }
        $normalized_post_types = [];
        foreach ($post_types as $post_type) {
            $post_type = (string) $post_type;
            if ($post_type === '' || !post_type_exists($post_type) || in_array($post_type, $normalized_post_types, true)) {
                return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} has an invalid canonical post type.", 409);
            }
            $normalized_post_types[] = $post_type;
        }
        $normalized_nodes = [];
        foreach ($nodes as $node_id => $node) {
            if (!is_string($node_id) || !is_array($node)) {
                return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} has an invalid localized node.", 409);
            }
            $pattern = zeroy_runtime_node_pattern($node_id);
            if (is_wp_error($pattern) || !in_array($node['kind'] ?? null, ['text', 'rich-text'], true) || !is_bool($node['required'] ?? null) || !is_bool($node['searchable'] ?? null)) {
                return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} has an invalid localized node {$node_id}.", 409);
            }
            foreach (array_keys($normalized_nodes) as $previous) {
                if (zeroy_runtime_patterns_overlap($previous, $node_id)) {
                    return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} has overlapping NodeId patterns.", 409);
                }
            }
            $normalized_nodes[$node_id] = [
                'kind' => $node['kind'],
                'required' => $node['required'],
                'searchable' => $node['searchable'],
            ];
        }
        if (count($normalized_nodes) === 0) {
            return zeroy_runtime_error('zeroy_schema_invalid', "Schema {$schema_id} must declare localized nodes.", 409);
        }
        $normalized['schemas'][$schema_id] = [
            'label' => $label,
            'template' => $template,
            'canonicalPostTypes' => $normalized_post_types,
            'nodes' => $normalized_nodes,
        ];
    }
    if (count($normalized['schemas']) === 0) {
        return zeroy_runtime_error('zeroy_schema_invalid', 'ThemeSchema must declare at least one schema.', 409);
    }
    return $normalized;
}

function zeroy_runtime_theme_schema(): array|WP_Error
{
    $diagnostics = zeroy_runtime_schema_diagnostics();
    if (!$diagnostics['valid']) {
        $error = $diagnostics['errors'][0];
        return zeroy_runtime_error('zeroy_schema_invalid', $error['message'], 409);
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

function zeroy_runtime_validate_document(array $document, array $definition, bool $complete): array|WP_Error
{
    if (array_is_list($document)) {
        return zeroy_runtime_error('zeroy_document_invalid', 'Locale documents must be keyed by NodeId.', 400);
    }
    foreach ($document as $node_id => $value) {
        if (!is_string($node_id) || !is_string($value) || zeroy_runtime_document_node($definition, $node_id) === null) {
            return zeroy_runtime_error('zeroy_document_invalid', 'Locale document has an unknown NodeId or a non-string value.', 400);
        }
    }
    if ($complete) {
        foreach ($definition['nodes'] as $node_id => $node) {
            if ($node['required'] && !str_contains($node_id, '*') && (!isset($document[$node_id]) || trim($document[$node_id]) === '')) {
                return zeroy_runtime_error('zeroy_document_incomplete', "Required localized NodeId {$node_id} is missing.", 409);
            }
        }
    }
    return $document;
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
}

function zeroy_runtime_assign_canonical_schema(int $object_id, string $schema_id, int $expected_revision): array|WP_Error
{
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

function zeroy_runtime_reserve_route(string $locale, string $route, int $object_id, string $url_prefix): true|WP_Error
{
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
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 400);
    }
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    if ($canonical['schemaId'] !== $schema_id) {
        return zeroy_runtime_error('zeroy_schema_assignment_mismatch', 'Locale content must use the canonical object\'s assigned ThemeSchema.', 409);
    }
    $route = zeroy_runtime_normalize_route($route);
    if (is_wp_error($route)) {
        return $route;
    }
    $definition = zeroy_runtime_schema_definition($schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $document = zeroy_runtime_validate_document($document, $definition, false);
    if (is_wp_error($document)) {
        return $document;
    }
    $schema_hash = zeroy_runtime_schema_hash($definition);
    $locale_config = zeroy_runtime_locale_config($locale);
    $url_prefix = is_array($locale_config) ? (string) $locale_config['urlPrefix'] : '';
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $schema_id, $route, $document, $expected_revision, $schema_hash, $url_prefix) {
        global $wpdb;
        $head = zeroy_runtime_locked_head($object_id, $locale);
        $current_revision = $head === null ? 0 : (int) $head['revision'];
        if ($current_revision !== $expected_revision) {
            return zeroy_runtime_error('zeroy_locale_conflict', 'LocaleHead changed after it was read.', 409, ['currentRevision' => $current_revision]);
        }
        if ($head !== null && $head['schema_id'] !== $schema_id) {
            return zeroy_runtime_error('zeroy_schema_assignment_mismatch', 'LocaleHead ThemeSchema does not match the canonical object.', 409);
        }
        $reservation = zeroy_runtime_reserve_route($locale, $route, $object_id, $url_prefix);
        if (is_wp_error($reservation)) {
            return $reservation;
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
                    'published_version_id' => null,
                    'revision' => $next_revision,
                    'updated_at' => current_time('mysql', true),
                ],
                ['%d', '%s', '%s', '%s', '%d', '%d', '%d', '%s']
            );
        } else {
            $written = $wpdb->query(
                $wpdb->prepare(
                    'UPDATE ' . zeroy_runtime_table('locale_heads') . ' SET route_path = %s, draft_version_id = %d, revision = %d, updated_at = %s WHERE object_id = %d AND locale = %s AND revision = %d',
                    $route,
                    $version_id,
                    $next_revision,
                    current_time('mysql', true),
                    $object_id,
                    $locale,
                    $expected_revision
                )
            );
        }
        if ($written !== 1) {
            return zeroy_runtime_error('zeroy_locale_write_failed', $wpdb->last_error ?: 'Could not update LocaleHead.', 409);
        }
        return zeroy_runtime_get_head($object_id, $locale);
    });
    if (is_wp_error($result)) {
        return $result;
    }
    flush_rewrite_rules(false);
    return zeroy_runtime_project_head($result, true);
}

function zeroy_runtime_search_text(array $document, array $definition): array
{
    $text = [];
    $title = '';
    foreach ($document as $node_id => $value) {
        $node = zeroy_runtime_document_node($definition, $node_id);
        if ($node !== null && $node['searchable']) {
            $plain = trim(wp_strip_all_tags($value));
            $text[] = $plain;
            if ($node_id === 'title' || $title === '') {
                $title = $plain;
            }
        }
    }
    return ['title' => $title, 'text' => trim(implode("\n", $text))];
}

function zeroy_runtime_publish_draft(int $object_id, string $locale, int $expected_revision): array|WP_Error
{
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled for this site.", 400);
    }
    $old_head = zeroy_runtime_get_head($object_id, $locale);
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $expected_revision) {
        global $wpdb;
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
        $definition = zeroy_runtime_schema_definition((string) $head['schema_id']);
        if ($version === null || is_wp_error($definition)) {
            return is_wp_error($definition) ? $definition : zeroy_runtime_error('zeroy_version_missing', 'Locale draft version is missing.', 409);
        }
        $current_hash = zeroy_runtime_schema_hash($definition);
        if (!hash_equals($current_hash, (string) $version['schema_hash'])) {
            return zeroy_runtime_error('zeroy_schema_changed', 'ThemeSchema changed after this draft was written. Rewrite the draft first.', 409);
        }
        $document = zeroy_runtime_decode_json((string) $version['document_json']);
        if (is_wp_error($document)) {
            return zeroy_runtime_error('zeroy_document_invalid', 'Locale draft JSON is invalid.', 409);
        }
        $document = zeroy_runtime_validate_document($document, $definition, true);
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
        $search = zeroy_runtime_search_text($document, $definition);
        $wpdb->replace(
            zeroy_runtime_table('search_projection'),
            [
                'object_id' => $object_id,
                'locale' => $locale,
                'published_version_id' => (int) $version['version_id'],
                'schema_id' => $head['schema_id'],
                'title' => $search['title'],
                'searchable_text' => $search['text'],
                'updated_at' => current_time('mysql', true),
            ],
            ['%d', '%s', '%d', '%s', '%s', '%s', '%s']
        );
        return zeroy_runtime_get_head($object_id, $locale);
    });
    if (is_wp_error($result)) {
        return $result;
    }
    zeroy_runtime_invalidate_document_cache($old_head);
    $canonical = zeroy_runtime_canonical($object_id);
    if (is_array($canonical) && $canonical['post']->post_status !== 'publish') {
        wp_update_post(['ID' => $object_id, 'post_status' => 'publish']);
    }
    flush_rewrite_rules(false);
    return zeroy_runtime_project_head($result, true);
}

function zeroy_runtime_unpublish(int $object_id, string $locale, int $expected_revision): array|WP_Error
{
    $old_head = zeroy_runtime_get_head($object_id, $locale);
    $result = zeroy_runtime_transaction(function () use ($object_id, $locale, $expected_revision) {
        global $wpdb;
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
        $wpdb->delete(zeroy_runtime_table('search_projection'), ['object_id' => $object_id, 'locale' => $locale], ['%d', '%s']);
        return zeroy_runtime_get_head($object_id, $locale);
    });
    if (is_wp_error($result)) {
        return $result;
    }
    zeroy_runtime_invalidate_document_cache($old_head);
    flush_rewrite_rules(false);
    return zeroy_runtime_project_head($result, true);
}

function zeroy_runtime_project_head(array $head, bool $include_documents = false): array
{
    $draft = $head['draft_version_id'] === null ? null : zeroy_runtime_get_version((int) $head['draft_version_id']);
    $published = $head['published_version_id'] === null ? null : zeroy_runtime_get_version((int) $head['published_version_id']);
    $definition = zeroy_runtime_schema_definition((string) $head['schema_id']);
    $schema_hash = is_array($definition) ? zeroy_runtime_schema_hash($definition) : null;
    $published_matches = $published !== null && $schema_hash !== null && hash_equals($schema_hash, (string) $published['schema_hash']);
    $locale_enabled = zeroy_runtime_locale_is_enabled((string) $head['locale']);
    $state = !$locale_enabled
        ? 'disabled'
        : ($published === null ? ($draft === null ? 'not-started' : 'draft') : ($published_matches ? 'published' : 'schema-mismatch'));
    $projected = [
        'objectId' => (int) $head['object_id'],
        'locale' => $head['locale'],
        'schemaId' => $head['schema_id'],
        'route' => $head['route_path'],
        'url' => $locale_enabled ? zeroy_runtime_route_url((string) $head['locale'], (string) $head['route_path']) : null,
        'revision' => (int) $head['revision'],
        'draftVersionId' => $head['draft_version_id'] === null ? null : (int) $head['draft_version_id'],
        'publishedVersionId' => $head['published_version_id'] === null ? null : (int) $head['published_version_id'],
        'state' => $state,
        'schemaMatchesPublished' => $published === null ? null : $published_matches,
    ];
    if ($include_documents) {
        $projected['draft'] = $draft === null ? null : [
            'versionId' => (int) $draft['version_id'],
            'schemaHash' => $draft['schema_hash'],
            'document' => zeroy_runtime_decode_json((string) $draft['document_json']),
            'createdAt' => $draft['created_at'],
        ];
        $projected['published'] = $published === null ? null : [
            'versionId' => (int) $published['version_id'],
            'schemaHash' => $published['schema_hash'],
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
    $definition = zeroy_runtime_schema_definition($schema_id);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $version = zeroy_runtime_get_version((int) $head['published_version_id']);
    if ($version === null || !hash_equals(zeroy_runtime_schema_hash($definition), (string) $version['schema_hash'])) {
        return zeroy_runtime_error('zeroy_schema_mismatch', 'Published locale document does not match the active ThemeSchema.', 404);
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
    $document = zeroy_runtime_validate_document($document, $definition, true);
    if (is_wp_error($document)) {
        return $document;
    }
    wp_cache_set($cache_key, $document, 'zeroy-runtime');
    return $document;
}

function zeroy_locale_document(int $object_id, string $locale, string $schema_id): array
{
    $document = zeroy_runtime_read_document($object_id, $locale, $schema_id);
    if (is_wp_error($document)) {
        wp_die($document->get_error_message(), 'zeroY locale document unavailable', ['response' => 404]);
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
    $hash = zeroy_runtime_schema_hash($definition);
    $heads = zeroy_runtime_table('locale_heads');
    $versions = zeroy_runtime_table('locale_versions');
    $search = zeroy_runtime_table('search_projection');
    $where = 'h.locale = %s AND h.schema_id = %s AND h.published_version_id = p.published_version_id AND v.schema_hash = %s';
    $arguments = [$locale, $schema_id, $hash];
    if ($query !== null && trim($query) !== '') {
        $where .= ' AND (p.title LIKE %s OR p.searchable_text LIKE %s)';
        $like = '%' . $wpdb->esc_like(trim($query)) . '%';
        $arguments[] = $like;
        $arguments[] = $like;
    }
    $from = " FROM {$heads} h JOIN {$versions} v ON v.version_id = h.published_version_id JOIN {$search} p ON p.object_id = h.object_id AND p.locale = h.locale";
    $count = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*)' . $from . ' WHERE ' . $where, ...$arguments));
    $offset = ($page - 1) * $per_page;
    $rows = $wpdb->get_results(
        $wpdb->prepare('SELECT h.object_id, h.locale, h.route_path, h.schema_id, h.published_version_id, p.title' . $from . ' WHERE ' . $where . ' ORDER BY h.object_id DESC LIMIT %d OFFSET %d', ...[...$arguments, $per_page, $offset]),
        ARRAY_A
    );
    $items = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $items[] = [
            'objectId' => (int) $row['object_id'],
            'locale' => $row['locale'],
            'schemaId' => $row['schema_id'],
            'route' => $row['route_path'],
            'url' => zeroy_runtime_route_url($row['locale'], $row['route_path']),
            'publishedVersionId' => (int) $row['published_version_id'],
            'title' => $row['title'],
        ];
    }
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $count];
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
                    'schemaMatchesPublished' => null,
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
    $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads'), ARRAY_A);
    foreach (is_array($heads) ? $heads : [] as $head) {
        $reservation = $wpdb->get_var(
            $wpdb->prepare('SELECT object_id FROM ' . zeroy_runtime_table('route_reservations') . ' WHERE locale = %s AND route_path = %s', $head['locale'], $head['route_path'])
        );
        if ((int) $reservation !== (int) $head['object_id']) {
            $issues[] = ['code' => 'route_reservation_missing', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'message' => 'LocaleHead route is not reserved by its canonical object.'];
        }
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] !== null && zeroy_runtime_get_version((int) $head[$pointer]) === null) {
                $issues[] = ['code' => 'version_pointer_missing', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'message' => "LocaleHead {$pointer} points at a missing LocaleVersion."];
            }
        }
        if ($head['published_version_id'] !== null) {
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
    update_option(ZEROY_RUNTIME_DATABASE_VERSION_OPTION, ZEROY_RUNTIME_DATABASE_VERSION, false);
    flush_rewrite_rules(false);
}

function zeroy_runtime_deactivate(): void
{
    flush_rewrite_rules(false);
}
