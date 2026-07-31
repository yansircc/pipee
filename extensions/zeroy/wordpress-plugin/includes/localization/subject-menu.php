<?php

defined('ABSPATH') || exit;

function zeroy_localization_menu_subject(int $menu_id): array|WP_Error
{
    $menu = wp_get_nav_menu_object($menu_id);
    if (!$menu instanceof WP_Term) {
        return zeroy_runtime_error('zeroy_localization_menu_missing', 'Canonical WordPress menu does not exist.', 404);
    }
    $items = wp_get_nav_menu_items($menu_id, ['post_status' => 'publish']);
    $fields = [];
    $view_items = [];
    foreach (is_array($items) ? $items : [] as $item) {
        if (!$item instanceof WP_Post) {
            continue;
        }
        $field_id = '/menu/' . $item->ID . '/label';
        $label = (string) $item->post_title;
        $fields[] = zeroy_localization_field($field_id, 'Menu: ' . $label, 'menu:label', $label, ['menu', 'items', (int) $item->ID, 'label']);
        $type = (string) $item->type;
        if ($type === 'custom') {
            $fields[] = zeroy_localization_field('/menu/' . $item->ID . '/url', 'Menu URL: ' . $label, 'menu:url', (string) $item->url, ['menu', 'items', (int) $item->ID, 'url']);
        }
        $view_items[(int) $item->ID] = [
            'label' => $label,
            'objectId' => (int) $item->object_id,
            'objectType' => $item->object,
            'type' => $type,
            'url' => $item->url,
            'parentId' => (int) $item->menu_item_parent,
            'position' => (int) $item->menu_order,
        ];
    }
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => ['kind' => 'menu', 'id' => $menu_id],
        'schemaId' => 'menu',
        'canonicalRevision' => zeroy_runtime_hash(['menuId' => $menu_id, 'items' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields)]),
        'fields' => $fields,
        'view' => ['menu' => ['items' => $view_items]],
    ];
}

function zeroy_localization_menu_post_url(int $post_id, string $locale): array
{
    $canonical = zeroy_runtime_canonical($post_id);
    $definition = is_wp_error($canonical) ? $canonical : zeroy_runtime_schema_definition((string) $canonical['schemaId']);
    $route = is_wp_error($definition) ? $definition : zeroy_localization_subject_route(['kind' => 'post', 'id' => $post_id], $definition);
    if (is_wp_error($route)) {
        return ['available' => false, 'url' => null];
    }
    foreach (zeroy_runtime_locale_links_for_post($post_id, $route) as $link) {
        if ($link['locale'] === $locale) {
            return ['available' => $link['available'], 'url' => $link['url']];
        }
    }
    return ['available' => false, 'url' => null];
}

function zeroy_localization_menu_term_url(int $term_id, string $taxonomy, string $locale): array
{
    $term = get_term($term_id, $taxonomy);
    $collection = $term instanceof WP_Term ? zeroy_runtime_collection_for_term($term) : null;
    return $collection === null
        ? ['available' => false, 'url' => null]
        : ['available' => true, 'url' => zeroy_runtime_route_url($locale, $collection['route'])];
}

function zeroy_localization_menu_archive_url(string $post_type, string $locale): array
{
    $collection = zeroy_runtime_collection_for_post_type($post_type);
    return $collection === null
        ? ['available' => false, 'url' => null]
        : ['available' => true, 'url' => zeroy_runtime_route_url($locale, $collection['route'])];
}

function zeroy_localization_menu_resolved_view(array $view, string $locale): array
{
    $items = $view['menu']['items'] ?? [];
    if (!is_array($items)) {
        return $view;
    }
    foreach ($items as $item_id => $item) {
        if (!is_array($item)) {
            continue;
        }
        $derived = match ($item['type'] ?? null) {
            'post_type' => zeroy_localization_menu_post_url((int) ($item['objectId'] ?? 0), $locale),
            'taxonomy' => zeroy_localization_menu_term_url((int) ($item['objectId'] ?? 0), (string) ($item['objectType'] ?? ''), $locale),
            'post_type_archive' => zeroy_localization_menu_archive_url((string) ($item['objectType'] ?? ''), $locale),
            'custom' => ['available' => true, 'url' => $item['url'] ?? null],
            default => ['available' => false, 'url' => null],
        };
        $view['menu']['items'][$item_id] = [...$item, ...$derived];
    }
    return $view;
}
