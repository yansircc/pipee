<?php

defined('ABSPATH') || exit;

function zeroy_runtime_normalize_collection_route(mixed $route, array $context, array &$errors): ?string
{
    $normalized = is_string($route) ? zeroy_runtime_normalize_route($route) : zeroy_runtime_error('zeroy_invalid_route', 'Collection route must be a string.', 409);
    if (is_wp_error($normalized) || $normalized === '') {
        zeroy_runtime_schema_violation($errors, 'collection_route_invalid', 'Collection route must be a non-empty relative path.', $context);
        return null;
    }
    return $normalized;
}

function zeroy_runtime_collection_route_spaces_overlap(string $left_kind, string $left_route, string $right_kind, string $right_route): bool
{
    if ($left_kind === $right_kind) {
        return $left_route === $right_route;
    }
    $archive = $left_kind === 'post-archive' ? $left_route : $right_route;
    $taxonomy = $left_kind === 'taxonomy' ? $left_route : $right_route;
    return str_starts_with($archive, $taxonomy . '/') && !str_contains(substr($archive, strlen($taxonomy) + 1), '/');
}

function zeroy_runtime_normalize_collections(mixed $collections, array $schemas, array &$errors, ?string $theme_root = null): array
{
    $theme_root ??= get_stylesheet_directory();
    if ($collections === null) {
        return [];
    }
    if (!zeroy_runtime_is_keyed_map($collections)) {
        zeroy_runtime_schema_violation($errors, 'collections_invalid', 'collections must be a keyed object.', ['field' => 'collections']);
        return [];
    }
    $normalized = [];
    $taxonomy_owners = [];
    foreach ($collections as $collection_id => $definition) {
        $context = ['collectionId' => $collection_id];
        if (!is_string($collection_id) || !preg_match('/\A[a-z][a-z0-9-]{0,95}\z/', $collection_id) || !is_array($definition) || array_is_list($definition)) {
            zeroy_runtime_schema_violation($errors, 'collection_invalid', 'Every collection needs a valid collectionId and object definition.', $context);
            continue;
        }
        $kind = $definition['kind'] ?? null;
        $label = is_string($definition['label'] ?? null) ? trim($definition['label']) : '';
        $route = zeroy_runtime_normalize_collection_route($definition['route'] ?? null, $context, $errors);
        $template = is_string($definition['template'] ?? null) ? ltrim(wp_normalize_path($definition['template']), '/') : '';
        $schema_id = $definition['schemaId'] ?? null;
        $taxonomy = $definition['taxonomy'] ?? null;
        // Candidate preparation must not execute Artifact PHP, so a taxonomy
        // registration cannot be a static Artifact invariant.  Keep this
        // boundary syntactic; query-time WordPress owns an absent taxonomy.
        if (!in_array($kind, zeroy_runtime_theme_authoring_collection_kinds(), true) || $label === '' || $route === null || !is_string($schema_id) || !isset($schemas[$schema_id]) || $template === '' || str_contains($template, '..') || !preg_match('/\A[a-zA-Z0-9_\-\/]+\.php\z/', $template) || !is_file($theme_root . '/' . $template) || ($kind === 'taxonomy' && (!is_string($taxonomy) || $taxonomy === '' || sanitize_key($taxonomy) !== $taxonomy))) {
            zeroy_runtime_schema_violation($errors, 'collection_definition_invalid', "Collection {$collection_id} is incomplete or invalid.", $context);
            continue;
        }
        foreach ($normalized as $existing_id => $existing) {
            if (zeroy_runtime_collection_route_spaces_overlap($kind, $route, $existing['kind'], $existing['route'])) {
                zeroy_runtime_schema_violation($errors, 'collection_route_overlap', "Collection route {$route} overlaps {$existing_id}.", $context + ['conflictsWith' => $existing_id]);
            }
        }
        if ($kind === 'taxonomy') {
            if (isset($taxonomy_owners[$taxonomy])) {
                zeroy_runtime_schema_violation($errors, 'collection_taxonomy_ambiguous', "Taxonomy {$taxonomy} is already owned by {$taxonomy_owners[$taxonomy]}.", $context + ['conflictsWith' => $taxonomy_owners[$taxonomy]]);
                continue;
            }
            $taxonomy_owners[$taxonomy] = $collection_id;
        }
        $normalized[$collection_id] = ['kind' => $kind, 'label' => $label, 'route' => $route, 'template' => $template, 'schemaId' => $schema_id, ...($kind === 'taxonomy' ? ['taxonomy' => $taxonomy] : [])];
    }
    return $normalized;
}

function zeroy_runtime_collection_for_term(WP_Term $term, ?array $collections = null): ?array
{
    $collections ??= zeroy_runtime_collection_definitions();
    if (is_wp_error($collections)) {
        return null;
    }
    foreach ($collections as $collection_id => $definition) {
        if ($definition['kind'] === 'taxonomy' && $definition['taxonomy'] === $term->taxonomy) {
            return ['collectionId' => $collection_id, 'definition' => $definition, 'route' => $definition['route'] . '/' . $term->slug];
        }
    }
    return null;
}

function zeroy_runtime_collection_for_post_type(string $post_type, ?array $collections = null): ?array
{
    $collections ??= zeroy_runtime_collection_definitions();
    if (is_wp_error($collections)) {
        return null;
    }
    foreach ($collections as $collection_id => $definition) {
        if ($definition['kind'] !== 'post-archive') {
            continue;
        }
        $schema = zeroy_runtime_schema_definition($definition['schemaId']);
        if (!is_wp_error($schema) && in_array($post_type, $schema['canonicalPostTypes'], true)) {
            return ['collectionId' => $collection_id, 'definition' => $definition, 'route' => $definition['route']];
        }
    }
    return null;
}

function zeroy_runtime_collection_definitions(): array|WP_Error
{
    $schema = zeroy_runtime_theme_schema();
    return is_wp_error($schema) ? $schema : ($schema['collections'] ?? []);
}

function zeroy_runtime_collection_for_relative_route(string $route, ?array $collections = null): ?array
{
    $collections ??= zeroy_runtime_collection_definitions();
    if (is_wp_error($collections)) {
        return null;
    }
    foreach ($collections as $collection_id => $definition) {
        if ($definition['kind'] === 'post-archive') {
            if ($route === $definition['route']) {
                return ['collectionId' => $collection_id, 'definition' => $definition, 'termSlug' => null, 'page' => 1];
            }
            if (preg_match('#\A' . preg_quote($definition['route'], '#') . '/page/([1-9][0-9]*)\z#', $route, $matches) === 1) {
                return ['collectionId' => $collection_id, 'definition' => $definition, 'termSlug' => null, 'page' => (int) $matches[1]];
            }
        }
        if ($definition['kind'] === 'taxonomy' && str_starts_with($route, $definition['route'] . '/')) {
            $suffix = substr($route, strlen($definition['route']) + 1);
            if (preg_match('#\A([^/]+)(?:/page/([1-9][0-9]*))?\z#', $suffix, $matches) === 1) {
                return ['collectionId' => $collection_id, 'definition' => $definition, 'termSlug' => $matches[1], 'page' => isset($matches[2]) ? (int) $matches[2] : 1];
            }
        }
    }
    return null;
}

function zeroy_runtime_collection_route_conflicts(array $schema): array
{
    $collections = $schema['collections'] ?? [];
    if ($collections === []) {
        return [];
    }
    global $wpdb;
    $rows = $wpdb->get_results('SELECT locale, route_path, subject_key FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE published_version_id IS NOT NULL', ARRAY_A);
    $conflicts = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $owner = zeroy_runtime_collection_for_relative_route((string) $row['route_path'], $collections);
        if ($owner !== null) {
            $conflicts[] = ['code' => 'collection_route_reserved', 'collectionId' => $owner['collectionId'], 'locale' => $row['locale'], 'route' => $row['route_path'], 'subjectKey' => $row['subject_key']];
        }
    }
    return $conflicts;
}
