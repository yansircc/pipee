<?php

defined('ABSPATH') || exit;

function zeroy_current_locale(): string
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    return is_array($context) ? (string) ($context['locale'] ?? '') : '';
}

function zeroy_collection_context(): array|WP_Error
{
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    return is_array($context) && in_array(($context['routeKind'] ?? null), ['archive', 'taxonomy'], true)
        ? $context
        : zeroy_runtime_error('zeroy_collection_context_missing', 'The current request is not a zeroY CollectionRoute.', 409);
}

function zeroy_localization_projection_select(array $select): array|WP_Error
{
    if (!array_is_list($select) || count($select) === 0 || count($select) > 50) {
        return zeroy_runtime_error('zeroy_entity_select_invalid', 'select must contain between 1 and 50 selectors.', 400);
    }
    $selectors = [];
    foreach ($select as $selector) {
        if ($selector === 'url') {
            $selectors['url'] = null;
            continue;
        }
        if (!is_string($selector) || !preg_match('#\A/(?:post|acf|template-content)(?:/[^/]+)+\z#', $selector)) {
            return zeroy_runtime_error('zeroy_entity_select_invalid', 'Selectors must be url or a JSON pointer rooted at /post, /acf, or /template-content.', 400);
        }
        $parts = zeroy_localization_pointer_parts($selector);
        if (is_wp_error($parts)) {
            return $parts;
        }
        $selectors[$selector] = $parts;
    }
    return $selectors;
}

function zeroy_localization_nested_value(array $view, array $path, bool &$found): mixed
{
    $cursor = $view;
    foreach ($path as $part) {
        if (!is_array($cursor) || !array_key_exists($part, $cursor)) {
            $found = false;
            return null;
        }
        $cursor = $cursor[$part];
    }
    $found = true;
    return $cursor;
}

function zeroy_locale_entities(array $object_ids, string $locale, array $select = ['url', '/post/title']): array|WP_Error
{
    if (!zeroy_runtime_locale_is_enabled($locale) || !array_is_list($object_ids) || count($object_ids) === 0 || count($object_ids) > 100) {
        return zeroy_runtime_error('zeroy_entity_ids_invalid', 'objectIds must contain between 1 and 100 IDs for an enabled locale.', 400);
    }
    $selectors = zeroy_localization_projection_select($select);
    if (is_wp_error($selectors)) {
        return $selectors;
    }
    $context = $GLOBALS['zeroy_runtime_theme_context'] ?? null;
    $snapshot_entities = is_array($context) && is_array($context['resolvedContent']['_entities'] ?? null) ? $context['resolvedContent']['_entities'] : null;
    if (is_array($snapshot_entities)) {
        $items = [];
        $unavailable = [];
        foreach (array_values(array_unique(array_map('intval', $object_ids))) as $object_id) {
            $item = $snapshot_entities[(string) $object_id] ?? null;
            if (!is_array($item)) {
                $unavailable[] = ['objectId' => $object_id, 'code' => 'zeroy_snapshot_entity_missing'];
                continue;
            }
            $fields = [];
            foreach ($selectors as $selector => $path) {
                if ($selector === 'url') continue;
                $found = false;
                $value = zeroy_localization_nested_value($item['fields'], $path, $found);
                if ($found) zeroy_localization_set_view_value($fields, $path, $value);
            }
            $items[] = [...$item, 'fields' => $fields, ...(array_key_exists('url', $selectors) ? [] : ['url' => null])];
        }
        return ['items' => $items, 'unavailable' => $unavailable];
    }
    $items = [];
    $unavailable = [];
    foreach (array_values(array_unique(array_map('intval', $object_ids))) as $object_id) {
        if ($object_id < 1) {
            return zeroy_runtime_error('zeroy_entity_ids_invalid', 'Every objectId must be positive.', 400);
        }
        $canonical = zeroy_runtime_canonical($object_id);
        if (is_wp_error($canonical)) {
            $unavailable[] = ['objectId' => $object_id, 'code' => $canonical->get_error_code()];
            continue;
        }
        $resolved = zeroy_localization_post_content($object_id, $locale, $canonical['schemaId']);
        if (is_wp_error($resolved)) {
            $unavailable[] = ['objectId' => $object_id, 'code' => $resolved->get_error_code(), 'message' => $resolved->get_error_message()];
            continue;
        }
        $fields = [];
        foreach ($selectors as $selector => $path) {
            if ($selector === 'url') {
                continue;
            }
            $found = false;
            $value = zeroy_localization_nested_value($resolved, $path, $found);
            if ($found) {
                zeroy_localization_set_view_value($fields, $path, $value);
            }
        }
        $definition = zeroy_runtime_schema_definition($canonical['schemaId']);
        $route = is_wp_error($definition)
            ? $definition
            : zeroy_localization_subject_route(['kind' => 'post', 'id' => $object_id], $definition);
        if (is_wp_error($route)) {
            $unavailable[] = ['objectId' => $object_id, 'code' => $route->get_error_code(), 'message' => $route->get_error_message()];
            continue;
        }
        $head = zeroy_localization_overlay_head(['kind' => 'post', 'id' => $object_id], $locale);
        $items[] = [
            'objectId' => $object_id,
            'locale' => $locale,
            'schemaId' => $canonical['schemaId'],
            'route' => $route,
            ...(array_key_exists('url', $selectors) ? ['url' => zeroy_runtime_route_url($locale, $route)] : []),
            'publishedVersionId' => $head === null ? null : $head['published_version_id'],
            'fields' => $fields,
        ];
    }
    return ['items' => $items, 'unavailable' => $unavailable];
}

function zeroy_collection_items(array $select = ['url', '/post/title'], int $page = 1, int $per_page = 12): array|WP_Error
{
    $context = zeroy_collection_context();
    if (is_wp_error($context)) {
        return $context;
    }
    if (is_array($context['archiveItems'] ?? null)) {
        $collection = is_array($context['collection'] ?? null) ? $context['collection'] : [];
        return ['items' => $context['archiveItems'], 'unavailable' => [], 'page' => (int) ($collection['page'] ?? 1), 'perPage' => (int) ($collection['perPage'] ?? $per_page), 'total' => (int) ($collection['total'] ?? count($context['archiveItems']))];
    }
    $collection = is_array($context['collection'] ?? null) ? $context['collection'] : [];
    $posts = get_posts(['post_type' => get_post_types(['public' => true]), 'post_status' => 'publish', 'posts_per_page' => -1, 'meta_key' => ZEROY_RUNTIME_SCHEMA_META, 'meta_value' => $collection['schemaId'] ?? '', 'fields' => 'ids']);
    $ids = array_map('intval', is_array($posts) ? $posts : []);
    if (($collection['kind'] ?? null) === 'taxonomy' && ($collection['term'] ?? null) instanceof WP_Term) {
        $assigned = get_objects_in_term($collection['term']->term_id, $collection['term']->taxonomy);
        $assigned = is_wp_error($assigned) ? [] : array_fill_keys(array_map('intval', $assigned), true);
        $ids = array_values(array_filter($ids, static fn(int $id): bool => isset($assigned[$id])));
    }
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $projection = zeroy_locale_entities(array_slice($ids, ($page - 1) * $per_page, $per_page), (string) $context['locale'], $select);
    return is_wp_error($projection) ? $projection : [...$projection, 'page' => $page, 'perPage' => $per_page, 'total' => count($ids)];
}

function zeroy_locale_archive(string $locale, string $schema_id, int $page = 1, int $per_page = 10): array|WP_Error
{
    if (!zeroy_runtime_locale_is_enabled($locale)) {
        return zeroy_runtime_error('zeroy_locale_disabled', "Locale {$locale} is not enabled.", 404);
    }
    $ids = get_posts(['post_type' => get_post_types(['public' => true]), 'post_status' => 'publish', 'posts_per_page' => -1, 'meta_key' => ZEROY_RUNTIME_SCHEMA_META, 'meta_value' => $schema_id, 'fields' => 'ids']);
    $ids = array_map('intval', is_array($ids) ? $ids : []);
    $projection = zeroy_locale_entities(array_slice($ids, (max(1, $page) - 1) * $per_page, $per_page), $locale, ['url', '/post/title', '/post/excerpt']);
    return is_wp_error($projection) ? $projection : [...$projection, 'page' => max(1, $page), 'perPage' => $per_page, 'total' => count($ids)];
}

function zeroy_locale_search(string $locale, string $schema_id, string $query, int $page = 1, int $per_page = 10): array|WP_Error
{
    $archive = zeroy_locale_archive($locale, $schema_id, 1, 100);
    if (is_wp_error($archive)) {
        return $archive;
    }
    $needle = mb_strtolower(trim($query));
    $items = array_values(array_filter($archive['items'], static function (array $item) use ($needle): bool {
        return $needle === '' || str_contains(mb_strtolower((string) ($item['fields']['post']['title'] ?? '')), $needle) || str_contains(mb_strtolower((string) ($item['fields']['post']['excerpt'] ?? '')), $needle);
    }));
    return ['items' => array_slice($items, (max(1, $page) - 1) * $per_page, $per_page), 'page' => max(1, $page), 'perPage' => $per_page, 'total' => count($items)];
}
