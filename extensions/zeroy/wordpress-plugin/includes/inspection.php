<?php

defined('ABSPATH') || exit;

function zeroy_runtime_inventory(int $page = 1, int $per_page = 50): array
{
    global $wpdb;
    $page = max(1, $page);
    $per_page = min(100, max(1, $per_page));
    $rows = $wpdb->get_results($wpdb->prepare(
        'SELECT p.ID, p.post_type, p.post_status, p.post_title, schema_meta.meta_value AS schema_id, revision_meta.meta_value AS revision FROM ' . $wpdb->posts . ' p JOIN ' . $wpdb->postmeta . ' schema_meta ON schema_meta.post_id = p.ID AND schema_meta.meta_key = %s LEFT JOIN ' . $wpdb->postmeta . ' revision_meta ON revision_meta.post_id = p.ID AND revision_meta.meta_key = %s ORDER BY p.ID DESC LIMIT %d OFFSET %d',
        ZEROY_RUNTIME_SCHEMA_META,
        ZEROY_RUNTIME_CANONICAL_REVISION_META,
        $per_page,
        ($page - 1) * $per_page
    ), ARRAY_A);
    $config = zeroy_runtime_site_config();
    $items = [];
    foreach (is_array($rows) ? $rows : [] as $row) {
        $subject = ['kind' => 'post', 'id' => (int) $row['ID']];
        $definition = zeroy_runtime_schema_definition((string) $row['schema_id']);
        $route = is_wp_error($definition) ? null : zeroy_localization_subject_route($subject, $definition);
        $locales = [];
        foreach (is_array($config) ? $config['enabledLocales'] : [] as $locale) {
            $coverage = zeroy_localization_translation_coverage($subject, $locale['locale'], $row['post_status'] === 'publish');
            $published = $coverage['state'] === 'published';
            $locales[] = [
                'locale' => $locale['locale'],
                'route' => is_wp_error($route) ? null : $route,
                'url' => $published && !is_wp_error($route) ? zeroy_runtime_route_url($locale['locale'], $route) : null,
                'state' => $coverage['state'],
                'translation' => $coverage['summary'],
                'lastPublishedAt' => $coverage['publishedAt'],
                ...(isset($coverage['revision']) ? ['revision' => $coverage['revision']] : []),
                ...(isset($coverage['code']) ? ['code' => $coverage['code']] : []),
            ];
        }
        $items[] = ['objectId' => $subject['id'], 'postType' => $row['post_type'], 'postStatus' => $row['post_status'], 'postTitle' => $row['post_title'], 'schemaId' => $row['schema_id'], 'revision' => (int) $row['revision'], 'locales' => $locales];
    }
    $total = (int) $wpdb->get_var($wpdb->prepare('SELECT COUNT(*) FROM ' . $wpdb->postmeta . ' WHERE meta_key = %s', ZEROY_RUNTIME_SCHEMA_META));
    return ['items' => $items, 'page' => $page, 'perPage' => $per_page, 'total' => $total];
}

function zeroy_runtime_acf_field_projection(array $field): array
{
    $projected = ['key' => (string) ($field['key'] ?? ''), 'name' => (string) ($field['name'] ?? ''), 'label' => (string) ($field['label'] ?? ''), 'type' => (string) ($field['type'] ?? ''), 'required' => (bool) ($field['required'] ?? false)];
    if (is_array($field['choices'] ?? null) && in_array($projected['type'], ['checkbox', 'radio', 'select', 'button_group'], true)) {
        $projected['choices'] = array_map(static fn(mixed $label, mixed $value): array => ['value' => (string) $value, 'label' => (string) $label], $field['choices'], array_keys($field['choices']));
    }
    if (is_array($field['sub_fields'] ?? null) && $field['sub_fields'] !== []) {
        $projected['children'] = array_map('zeroy_runtime_acf_field_projection', $field['sub_fields']);
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
        $groups[] = ['key' => (string) ($group['key'] ?? ''), 'title' => (string) ($group['title'] ?? ''), 'location' => $group['location'] ?? [], 'fields' => is_array($fields) ? array_map('zeroy_runtime_acf_field_projection', $fields) : []];
    }
    return ['available' => true, 'fieldGroups' => $groups];
}

function zeroy_runtime_integrity(): array
{
    global $wpdb;
    $issues = [];
    $diagnostics = zeroy_runtime_schema_diagnostics();
    foreach ($diagnostics['errors'] as $error) {
        $issues[] = $error;
    }
    foreach ($wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_overlay_heads'), ARRAY_A) ?: [] as $head) {
        $subject = zeroy_runtime_decode_json((string) $head['subject_json']);
        if (is_wp_error($subject)) {
            $issues[] = ['code' => 'overlay_subject_invalid', 'subjectKey' => $head['subject_key']];
            continue;
        }
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] !== null && zeroy_localization_overlay_version((int) $head[$pointer]) === null) {
                $issues[] = ['code' => 'overlay_pointer_missing', 'subjectKey' => $head['subject_key'], 'locale' => $head['locale'], 'pointer' => $pointer];
            }
        }
    }
    $active = zeroy_runtime_active_site_release();
    if ($active === null) {
        $issues[] = ['code' => 'active_site_release_missing'];
    } else {
        $artifact = zeroy_runtime_artifact_integrity((string) $active['theme_artifact_id']);
        if (is_wp_error($artifact) || !($artifact['ok'] ?? false)) {
            $issues[] = ['code' => is_wp_error($artifact) ? $artifact->get_error_code() : 'theme-drift'];
        }
        $logic = zeroy_runtime_site_logic_artifact_integrity((string) $active['site_logic_artifact_id']);
        if (is_wp_error($logic) || !($logic['ok'] ?? false)) {
            $issues[] = ['code' => is_wp_error($logic) ? $logic->get_error_code() : 'site-logic-drift'];
        }
    }
    $checkout = zeroy_checkout_reachability();
    $issues = [...$issues, ...$checkout['issues']];
    return ['ok' => $issues === [], 'issues' => $issues];
}
