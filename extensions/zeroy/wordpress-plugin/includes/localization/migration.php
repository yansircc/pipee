<?php

defined('ABSPATH') || exit;

/**
 * Composition root for the one-shot hard-cut importer.  These modules are
 * transition writers only: no request-time reader imports an old document.
 */
require_once __DIR__ . '/migration/shared.php';
require_once __DIR__ . '/migration/acf-path.php';
require_once __DIR__ . '/migration/template-content.php';
require_once __DIR__ . '/migration/post-overlays.php';
require_once __DIR__ . '/migration/site-copy.php';

function zeroy_localization_legacy_migration_plan(array $schema): array
{
    if (!zeroy_localization_legacy_table_exists('locale_heads')) {
        return ['required' => false, 'items' => [], 'ok' => true];
    }

    $items = [
        ...zeroy_localization_legacy_post_migration_plan($schema),
        ...zeroy_localization_legacy_site_copy_migration_plan($schema),
    ];
    $blockers = array_values(array_filter($items, static fn(array $item): bool => $item['state'] === 'incompatible'));
    return ['required' => $items !== [], 'items' => $items, 'ok' => $blockers === []];
}

function zeroy_localization_apply_legacy_migration(array $schema): array|WP_Error
{
    $plan = zeroy_localization_legacy_migration_plan($schema);
    if (!$plan['ok']) {
        return zeroy_runtime_error('zeroy_legacy_locale_migration_blocked', 'Legacy LocaleVersion data cannot be migrated by the candidate LocalizationPolicy.', 409, ['items' => $plan['items']]);
    }
    if (!$plan['required']) {
        return ['migratedHeads' => 0, 'migratedTemplateContent' => 0, 'migratedSiteCopyHeads' => 0];
    }

    $site_copy = zeroy_localization_apply_legacy_site_copy_migration($schema);
    if (is_wp_error($site_copy)) {
        return $site_copy;
    }
    $posts = zeroy_localization_apply_legacy_post_migration($schema);
    if (is_wp_error($posts)) {
        return $posts;
    }

    return [
        'migratedHeads' => $posts['migratedHeads'],
        'migratedTemplateContent' => $posts['migratedTemplateContent'],
        'migratedSiteCopyHeads' => $site_copy['migratedHeads'],
    ];
}
