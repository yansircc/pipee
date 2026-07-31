<?php

defined('ABSPATH') || exit;

function zeroy_localization_legacy_site_copy_definition(array $schema): array|WP_Error
{
    $definition = $schema['localizationSubjects']['siteCopy'] ?? null;
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_legacy_site_copy_unsupported', 'Candidate ThemeSchema does not declare a SiteCopy LocalizationPolicy.', 409);
}
function zeroy_localization_legacy_theme_copy_nodes(array $document): array|WP_Error
{
    $nodes = $document['nodes'] ?? null;
    if (!zeroy_runtime_is_keyed_map($nodes)) {
        return zeroy_runtime_error('zeroy_legacy_theme_copy_corrupt', 'Legacy ThemeCopy nodes must be a keyed object.', 409);
    }
    foreach ($nodes as $key => $value) {
        if (!is_string($key) || $key === '' || !is_string($value)) {
            return zeroy_runtime_error('zeroy_legacy_theme_copy_corrupt', 'Legacy ThemeCopy values must be keyed strings.', 409);
        }
    }
    return $nodes;
}

function zeroy_localization_legacy_theme_copy_head(string $locale): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = 0 AND locale = %s', $locale),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_localization_legacy_theme_copy_overlay(array $document, array $compiled, string $locale, string $created_at): array|WP_Error
{
    $nodes = zeroy_localization_legacy_theme_copy_nodes($document);
    if (is_wp_error($nodes)) {
        return $nodes;
    }
    $values = [];
    foreach ($nodes as $key => $value) {
        $field_id = '/site-copy/' . zeroy_localization_pointer_segment($key);
        $field = $compiled['fields'][$field_id] ?? null;
        if (!is_array($field) || !in_array($field['policy']['mode'], ['translated', 'overridable'], true)) {
            return zeroy_runtime_error('zeroy_legacy_theme_copy_unmapped', 'Legacy ThemeCopy contains a value the candidate SiteCopy policy does not own.', 409, ['key' => $key]);
        }
        $values[$field_id] = ['sourceHash' => $field['sourceHash'], 'value' => $value];
    }
    return [
        'contract' => zeroy_localization_overlay_contract(),
        'subject' => ['kind' => 'site-copy', 'id' => 'default'],
        'locale' => $locale,
        'policyHash' => $compiled['policy']['hash'],
        'values' => $values,
        'createdAt' => $created_at,
    ];
}

function zeroy_localization_legacy_site_copy_migration_plan(array $schema): array
{
    global $wpdb;
    $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = 0 ORDER BY locale', ARRAY_A) ?: [];
    if ($heads === []) {
        return [];
    }
    $definition = zeroy_localization_legacy_site_copy_definition($schema);
    if (is_wp_error($definition)) {
        return [['state' => 'incompatible', 'scope' => 'legacy-theme-copy', 'code' => $definition->get_error_code(), 'message' => $definition->get_error_message()]];
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return [['state' => 'incompatible', 'scope' => 'legacy-theme-copy', 'code' => $config->get_error_code(), 'message' => $config->get_error_message()]];
    }
    $default = zeroy_localization_legacy_theme_copy_head($config['defaultLocale']);
    $default_document = $default === null ? zeroy_runtime_error('zeroy_legacy_theme_copy_missing', 'Legacy default-locale ThemeCopy is missing.', 409) : zeroy_localization_legacy_document($default, 'published_version_id');
    $nodes = is_wp_error($default_document) ? $default_document : zeroy_localization_legacy_theme_copy_nodes($default_document);
    if (is_wp_error($nodes)) {
        return [['state' => 'incompatible', 'scope' => 'legacy-theme-copy', 'code' => $nodes->get_error_code(), 'message' => $nodes->get_error_message()]];
    }
    $subject = zeroy_localization_site_copy_subject_from_values($nodes, (int) $config['revision'] + 1);
    $compiled = is_wp_error($subject) ? $subject : zeroy_localization_compile_subject_policy($subject, $definition);
    if (is_wp_error($compiled)) {
        return [['state' => 'incompatible', 'scope' => 'legacy-theme-copy', 'code' => $compiled->get_error_code(), 'message' => $compiled->get_error_message()]];
    }
    $items = [];
    foreach ($heads as $head) {
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] === null || $head['locale'] === $config['defaultLocale']) {
                continue;
            }
            $document = zeroy_localization_legacy_document($head, $pointer);
            $overlay = is_wp_error($document) ? $document : zeroy_localization_legacy_theme_copy_overlay($document, $compiled, (string) $head['locale'], (string) $head['updated_at']);
            if (is_wp_error($overlay)) {
                $items[] = ['state' => 'incompatible', 'scope' => 'legacy-theme-copy', 'locale' => $head['locale'], 'pointer' => $pointer, 'code' => $overlay->get_error_code(), 'message' => $overlay->get_error_message()];
            }
        }
        $items[] = ['state' => 'would-migrate', 'subjectKey' => 'site-copy:default', 'locale' => $head['locale'], 'schemaId' => 'site-copy'];
    }
    return $items;
}

function zeroy_localization_apply_legacy_site_copy_migration(array $schema): array|WP_Error
{
    global $wpdb;
    $heads = $wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id = 0 ORDER BY locale', ARRAY_A) ?: [];
    if ($heads === []) {
        return ['migratedHeads' => 0];
    }
    $definition = zeroy_localization_legacy_site_copy_definition($schema);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return $config;
    }
    $default = zeroy_localization_legacy_theme_copy_head($config['defaultLocale']);
    $document = $default === null ? zeroy_runtime_error('zeroy_legacy_theme_copy_missing', 'Legacy default-locale ThemeCopy is missing.', 409) : zeroy_localization_legacy_document($default, 'published_version_id');
    $nodes = is_wp_error($document) ? $document : zeroy_localization_legacy_theme_copy_nodes($document);
    if (is_wp_error($nodes)) {
        return $nodes;
    }
    $next = zeroy_runtime_validate_site_config([...$config, 'siteCopy' => $nodes]);
    if (is_wp_error($next)) {
        return $next;
    }
    $next_revision = (int) $config['revision'] + 1;
    $updated = $wpdb->query($wpdb->prepare(
        'UPDATE ' . zeroy_runtime_table('site_config') . ' SET config_json = %s, revision = %d WHERE singleton = 1 AND revision = %d',
        zeroy_runtime_json($next),
        $next_revision,
        $config['revision']
    ));
    if ($updated !== 1) {
        return zeroy_runtime_error('zeroy_legacy_site_copy_conflict', 'SiteConfig changed during legacy ThemeCopy migration.', 409);
    }
    $next['revision'] = $next_revision;
    $subject = zeroy_localization_site_copy_subject_from_values($next['siteCopy'], $next_revision);
    $compiled = is_wp_error($subject) ? $subject : zeroy_localization_compile_subject_policy($subject, $definition);
    if (is_wp_error($compiled)) {
        return $compiled;
    }
    $migrated = 0;
    foreach ($heads as $head) {
        if ($head['locale'] === $next['defaultLocale']) {
            continue;
        }
        $pointers = [];
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] === null) {
                $pointers[$pointer] = null;
                continue;
            }
            $legacy = zeroy_localization_legacy_document($head, $pointer);
            $overlay = is_wp_error($legacy) ? $legacy : zeroy_localization_legacy_theme_copy_overlay($legacy, $compiled, (string) $head['locale'], (string) $head['updated_at']);
            if (is_wp_error($overlay)) {
                return $overlay;
            }
            $pointers[$pointer] = zeroy_localization_insert_overlay_version($overlay, 'site-copy:default', $compiled['policy']['hash']);
            if (is_wp_error($pointers[$pointer])) {
                return $pointers[$pointer];
            }
        }
        $written = $wpdb->insert(zeroy_runtime_table('locale_overlay_heads'), [
            'subject_key' => 'site-copy:default', 'subject_kind' => 'site-copy', 'subject_json' => zeroy_runtime_json(['kind' => 'site-copy', 'id' => 'default']), 'locale' => $head['locale'], 'schema_id' => 'site-copy', 'route_path' => '', 'draft_version_id' => $pointers['draft_version_id'], 'published_version_id' => $pointers['published_version_id'], 'revision' => $head['revision'], 'updated_at' => $head['updated_at'],
        ]);
        if ($written !== 1) {
            return zeroy_runtime_error('zeroy_legacy_theme_copy_migration_failed', $wpdb->last_error ?: 'Could not write migrated SiteCopy LocaleOverlay head.', 500);
        }
        $migrated++;
    }
    return ['migratedHeads' => $migrated];
}
