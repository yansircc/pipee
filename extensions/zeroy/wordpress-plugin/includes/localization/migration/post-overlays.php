<?php

defined('ABSPATH') || exit;

function zeroy_localization_legacy_post_migration_plan(array $schema): array
{
    global $wpdb;
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return [['state' => 'incompatible', 'scope' => 'site-config', 'code' => $config->get_error_code(), 'message' => $config->get_error_message()]];
    }
    $items = [];
    foreach ($wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id != 0 ORDER BY object_id, locale', ARRAY_A) ?: [] as $head) {
        $definition = $schema['schemas'][$head['schema_id']] ?? null;
        if (!is_array($definition)) {
            $items[] = ['state' => 'incompatible', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'code' => 'schema_definition_missing'];
            continue;
        }
        $subject = zeroy_localization_post_subject((int) $head['object_id'], $definition);
        $compiled = is_wp_error($subject) ? $subject : zeroy_localization_compile_subject_policy($subject, $definition);
        if (is_wp_error($compiled)) {
            $items[] = ['state' => 'incompatible', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'code' => $compiled->get_error_code(), 'message' => $compiled->get_error_message()];
            continue;
        }
        if ($head['locale'] === $config['defaultLocale']) {
            $pointer = $head['published_version_id'] === null ? 'draft_version_id' : 'published_version_id';
            $document = zeroy_localization_legacy_document($head, $pointer);
            $template = is_wp_error($document)
                ? $document
                : zeroy_localization_legacy_default_template_content($document, (int) $head['object_id'], $definition);
            if (is_wp_error($template)) {
                $items[] = ['state' => 'incompatible', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'pointer' => $pointer, 'code' => $template->get_error_code(), 'message' => $template->get_error_message()];
            }
            $items[] = ['state' => 'would-migrate-canonical-template-content', 'subjectKey' => 'post:' . (int) $head['object_id'], 'locale' => $head['locale'], 'schemaId' => $head['schema_id']];
            continue;
        }
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] === null) {
                continue;
            }
            $document = zeroy_localization_legacy_document($head, $pointer);
            $overlay = is_wp_error($document) ? $document : zeroy_localization_legacy_overlay($document, $compiled['fields'], ['kind' => 'post', 'id' => (int) $head['object_id']], (string) $head['locale'], $compiled['policy']['hash'], (string) $head['updated_at']);
            if (is_wp_error($overlay)) {
                $items[] = ['state' => 'incompatible', 'objectId' => (int) $head['object_id'], 'locale' => $head['locale'], 'pointer' => $pointer, 'code' => $overlay->get_error_code(), 'message' => $overlay->get_error_message()];
            }
        }
        $items[] = ['state' => 'would-migrate', 'subjectKey' => 'post:' . (int) $head['object_id'], 'locale' => $head['locale'], 'schemaId' => $head['schema_id']];
    }
    return $items;
}

function zeroy_localization_apply_legacy_post_migration(array $schema): array|WP_Error
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return $config;
    }
    global $wpdb;
    $migrated = 0;
    $template_content = 0;
    foreach ($wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_heads') . ' WHERE object_id != 0 ORDER BY object_id, locale', ARRAY_A) ?: [] as $head) {
        if ($head['locale'] === $config['defaultLocale']) {
            $definition = $schema['schemas'][$head['schema_id']] ?? null;
            if (!is_array($definition)) {
                return zeroy_runtime_error('zeroy_legacy_locale_migration_blocked', 'Legacy LocaleHead references a missing candidate ThemeSchema.', 409, ['objectId' => (int) $head['object_id']]);
            }
            $pointer = $head['published_version_id'] === null ? 'draft_version_id' : 'published_version_id';
            $document = zeroy_localization_legacy_document($head, $pointer);
            $written = is_wp_error($document)
                ? $document
                : zeroy_localization_apply_legacy_default_template_content($document, (int) $head['object_id'], $definition);
            if (is_wp_error($written)) {
                return $written;
            }
            $template_content++;
            continue;
        }
        $definition = $schema['schemas'][$head['schema_id']] ?? null;
        if (!is_array($definition)) {
            return zeroy_runtime_error('zeroy_legacy_locale_migration_blocked', 'Legacy LocaleHead references a missing candidate ThemeSchema.', 409, ['objectId' => (int) $head['object_id']]);
        }
        $subject = zeroy_localization_post_subject((int) $head['object_id'], $definition);
        $compiled = is_wp_error($subject) ? $subject : zeroy_localization_compile_subject_policy($subject, $definition);
        if (is_wp_error($compiled)) {
            return $compiled;
        }
        $pointers = [];
        foreach (['draft_version_id', 'published_version_id'] as $pointer) {
            if ($head[$pointer] === null) {
                $pointers[$pointer] = null;
                continue;
            }
            $document = zeroy_localization_legacy_document($head, $pointer);
            $overlay = is_wp_error($document) ? $document : zeroy_localization_legacy_overlay($document, $compiled['fields'], ['kind' => 'post', 'id' => (int) $head['object_id']], (string) $head['locale'], $compiled['policy']['hash'], (string) $head['updated_at']);
            if (is_wp_error($overlay)) {
                return $overlay;
            }
            $pointers[$pointer] = zeroy_localization_insert_overlay_version($overlay, 'post:' . (int) $head['object_id'], $compiled['policy']['hash']);
            if (is_wp_error($pointers[$pointer])) {
                return $pointers[$pointer];
            }
        }
        $written = $wpdb->insert(zeroy_runtime_table('locale_overlay_heads'), [
            'subject_key' => 'post:' . (int) $head['object_id'], 'subject_kind' => 'post', 'subject_json' => zeroy_runtime_json(['kind' => 'post', 'id' => (int) $head['object_id']]), 'locale' => $head['locale'], 'schema_id' => $head['schema_id'], 'route_path' => $head['route_path'], 'draft_version_id' => $pointers['draft_version_id'], 'published_version_id' => $pointers['published_version_id'], 'revision' => $head['revision'], 'updated_at' => $head['updated_at'],
        ]);
        if ($written !== 1) {
            return zeroy_runtime_error('zeroy_legacy_locale_migration_failed', $wpdb->last_error ?: 'Could not write migrated LocaleOverlay head.', 500);
        }
        $migrated++;
    }
    return ['migratedHeads' => $migrated, 'migratedTemplateContent' => $template_content];
}
