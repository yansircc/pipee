<?php

defined('ABSPATH') || exit;

function zeroy_localization_overlay_contract(): string
{
    return 'zeroy/locale-overlay@1';
}

function zeroy_localization_overlay_head(array $subject, string $locale): ?array
{
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare(
            'SELECT * FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE subject_key = %s AND locale = %s',
            zeroy_localization_subject_key($subject),
            $locale
        ),
        ARRAY_A
    );
    return is_array($row) ? $row : null;
}

function zeroy_localization_overlay_version(int $version_id): ?array
{
    global $wpdb;
    $row = $wpdb->get_row($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_overlay_versions') . ' WHERE version_id = %d', $version_id), ARRAY_A);
    return is_array($row) ? $row : null;
}

function zeroy_localization_decode_overlay(array $row): array|WP_Error
{
    $overlay = zeroy_runtime_decode_json((string) ($row['overlay_json'] ?? ''));
    if (is_wp_error($overlay) || ($overlay['contract'] ?? null) !== zeroy_localization_overlay_contract() || !zeroy_runtime_is_keyed_map($overlay['values'] ?? null)) {
        return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'Stored LocaleOverlay is invalid.', 409);
    }
    return $overlay;
}

function zeroy_localization_empty_overlay(array $subject, string $locale, string $policy_hash): array
{
    return [
        'contract' => zeroy_localization_overlay_contract(),
        'subject' => $subject,
        'locale' => $locale,
        'policyHash' => $policy_hash,
        'values' => [],
        'createdAt' => current_time('mysql', true),
    ];
}

function zeroy_localization_overlay_for_head(?array $head, string $pointer, array $subject, string $locale, string $policy_hash): array|WP_Error
{
    if ($head === null || $head[$pointer] === null) {
        return zeroy_localization_empty_overlay($subject, $locale, $policy_hash);
    }
    $version = zeroy_localization_overlay_version((int) $head[$pointer]);
    if ($version === null) {
        return zeroy_runtime_error('zeroy_locale_overlay_corrupt', "LocaleOverlay {$pointer} points to a missing immutable version.", 409);
    }
    $overlay = zeroy_localization_decode_overlay($version);
    if (is_wp_error($overlay)) {
        return $overlay;
    }
    if (!hash_equals($policy_hash, (string) ($overlay['policyHash'] ?? ''))) {
        return zeroy_runtime_error('zeroy_localization_policy_changed', 'LocaleOverlay belongs to a different LocalizationPolicy.', 409);
    }
    return $overlay;
}

function zeroy_localization_insert_overlay_version(array $overlay, string $subject_key, string $policy_hash): int|WP_Error
{
    global $wpdb;
    $created = $wpdb->insert(
        zeroy_runtime_table('locale_overlay_versions'),
        [
            'subject_key' => $subject_key,
            'locale' => $overlay['locale'],
            'policy_hash' => $policy_hash,
            'overlay_json' => zeroy_runtime_json($overlay),
            'created_at' => $overlay['createdAt'],
        ],
        ['%s', '%s', '%s', '%s', '%s']
    );
    return $created === 1
        ? (int) $wpdb->insert_id
        : zeroy_runtime_error('zeroy_locale_overlay_write_failed', $wpdb->last_error ?: 'Could not write immutable LocaleOverlay.', 500);
}

function zeroy_localization_store_draft(
    array $subject,
    string $locale,
    string $schema_id,
    string $route_path,
    array $overlay,
    int $expected_revision
): array|WP_Error {
    global $wpdb;
    $subject_key = zeroy_localization_subject_key($subject);
    $head = zeroy_localization_overlay_head($subject, $locale);
    $current_revision = $head === null ? 0 : (int) $head['revision'];
    if ($current_revision !== $expected_revision) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed after this TranslationJob was read.', 409, ['currentRevision' => $current_revision]);
    }
    $version_id = zeroy_localization_insert_overlay_version($overlay, $subject_key, (string) $overlay['policyHash']);
    if (is_wp_error($version_id)) {
        return $version_id;
    }
    $now = current_time('mysql', true);
    $next_revision = $current_revision + 1;
    if ($head === null) {
        $written = $wpdb->insert(
            zeroy_runtime_table('locale_overlay_heads'),
            [
                'subject_key' => $subject_key,
                'subject_kind' => $subject['kind'],
                'subject_json' => zeroy_runtime_json($subject),
                'locale' => $locale,
                'schema_id' => $schema_id,
                'route_path' => $route_path,
                'draft_version_id' => $version_id,
                'published_version_id' => null,
                'revision' => $next_revision,
                'updated_at' => $now,
            ],
            ['%s', '%s', '%s', '%s', '%s', '%s', '%d', '%d', '%d', '%s']
        );
    } else {
        $written = $wpdb->query($wpdb->prepare(
            'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET schema_id = %s, route_path = %s, draft_version_id = %d, revision = %d, updated_at = %s WHERE subject_key = %s AND locale = %s AND revision = %d',
            $schema_id,
            $route_path,
            $version_id,
            $next_revision,
            $now,
            $subject_key,
            $locale,
            $current_revision
        ));
    }
    if ($written !== 1) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed while writing draft.', 409);
    }
    return zeroy_localization_overlay_head($subject, $locale) ?? zeroy_runtime_error('zeroy_locale_overlay_write_failed', 'New LocaleOverlay head was not readable.', 500);
}

function zeroy_localization_publish_draft(array $subject, string $locale, int $expected_revision): array|WP_Error
{
    global $wpdb;
    $head = zeroy_localization_overlay_head($subject, $locale);
    if ($head === null || $head['draft_version_id'] === null) {
        return zeroy_runtime_error('zeroy_translation_draft_missing', 'No Translation draft exists to publish.', 409);
    }
    if ((int) $head['revision'] !== $expected_revision) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed after this TranslationJob was read.', 409, ['currentRevision' => (int) $head['revision']]);
    }
    $next_revision = (int) $head['revision'] + 1;
    $published_at = current_time('mysql', true);
    $updated = $wpdb->query($wpdb->prepare(
        'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET published_version_id = draft_version_id, published_at = %s, revision = %d, updated_at = %s WHERE subject_key = %s AND locale = %s AND revision = %d',
        $published_at,
        $next_revision,
        $published_at,
        zeroy_localization_subject_key($subject),
        $locale,
        $expected_revision
    ));
    return $updated === 1
        ? (zeroy_localization_overlay_head($subject, $locale) ?? zeroy_runtime_error('zeroy_translation_publish_failed', 'Published LocaleOverlay head was not readable.', 500))
        : zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed while publishing.', 409);
}

function zeroy_localization_unpublish(array $subject, string $locale, int $expected_revision): array|WP_Error
{
    global $wpdb;
    $head = zeroy_localization_overlay_head($subject, $locale);
    if ($head === null || $head['published_version_id'] === null) {
        return zeroy_runtime_error('zeroy_translation_not_published', 'No published Translation exists to unpublish.', 409);
    }
    if ((int) $head['revision'] !== $expected_revision) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed after this TranslationJob was read.', 409, ['currentRevision' => (int) $head['revision']]);
    }
    $next_revision = (int) $head['revision'] + 1;
    $updated = $wpdb->query($wpdb->prepare(
        'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET published_version_id = NULL, revision = %d, updated_at = %s WHERE subject_key = %s AND locale = %s AND revision = %d',
        $next_revision,
        current_time('mysql', true),
        zeroy_localization_subject_key($subject),
        $locale,
        $expected_revision
    ));
    return $updated === 1
        ? (zeroy_localization_overlay_head($subject, $locale) ?? zeroy_runtime_error('zeroy_translation_unpublish_failed', 'Unpublished LocaleOverlay head was not readable.', 500))
        : zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleOverlay changed while unpublishing.', 409);
}
