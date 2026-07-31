<?php

defined('ABSPATH') || exit;

function zeroy_localization_write_reconciled_head(array $reconciliation): array|WP_Error
{
    global $wpdb;
    $head = $reconciliation['head'];
    $next_pointers = [];
    $versions = [];
    $discarded = [];
    foreach ($reconciliation['pointers'] as $pointer => $entry) {
        if ($entry === null) {
            $next_pointers[$pointer] = null;
            continue;
        }
        $source_id = $entry['sourceVersionId'];
        if (!$entry['requiresNewVersion']) {
            $next_pointers[$pointer] = $source_id;
            continue;
        }
        if (!isset($versions[$source_id])) {
            $version_id = zeroy_localization_insert_overlay_version($entry['overlay'], $head['subject_key'], $reconciliation['policyHash']);
            if (is_wp_error($version_id)) {
                return $version_id;
            }
            $versions[$source_id] = $version_id;
            $discarded = [...$discarded, ...$entry['discardedFields']];
        }
        $next_pointers[$pointer] = $versions[$source_id];
    }
    $next_revision = (int) $head['revision'] + 1;
    $arguments = [$head['schema_id'], $reconciliation['route']];
    $sql = 'UPDATE ' . zeroy_runtime_table('locale_overlay_heads') . ' SET schema_id = %s, route_path = %s, draft_version_id = ';
    if ($next_pointers['draft_version_id'] === null) {
        $sql .= 'NULL';
    } else {
        $sql .= '%d';
        $arguments[] = $next_pointers['draft_version_id'];
    }
    $sql .= ', published_version_id = ';
    if ($next_pointers['published_version_id'] === null) {
        $sql .= 'NULL';
    } else {
        $sql .= '%d';
        $arguments[] = $next_pointers['published_version_id'];
    }
    $sql .= ', revision = %d, updated_at = %s WHERE subject_key = %s AND locale = %s AND revision = %d';
    $arguments = [...$arguments, $next_revision, current_time('mysql', true), $head['subject_key'], $head['locale'], (int) $head['revision']];
    $written = $wpdb->query($wpdb->prepare($sql, ...$arguments));
    if ($written !== 1) {
        return zeroy_runtime_error('zeroy_locale_overlay_conflict', 'LocaleHead changed while reconciling the candidate ThemeSchema.', 409, ['subjectKey' => $head['subject_key'], 'locale' => $head['locale']]);
    }
    return [
        ...$reconciliation['summary'],
        'state' => $reconciliation['summary']['pointers'] !== [] ? 'migrated' : 'route-updated',
        'migratedVersions' => count($versions),
        'discardedFields' => array_values(array_unique($discarded)),
    ];
}

function zeroy_localization_apply_overlay_reconciliation(array $schema): array|WP_Error
{
    global $wpdb;
    $affected = [];
    $migrated_heads = 0;
    $migrated_versions = 0;
    foreach ($wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_overlay_heads'), ARRAY_A) ?: [] as $head) {
        $reconciliation = zeroy_localization_reconciliation_head($head, $schema);
        if (is_wp_error($reconciliation)) {
            return $reconciliation;
        }
        if (!$reconciliation['requiresUpdate']) {
            continue;
        }
        $written = zeroy_localization_write_reconciled_head($reconciliation);
        if (is_wp_error($written)) {
            return $written;
        }
        $affected[] = $written;
        $migrated_heads++;
        $migrated_versions += (int) $written['migratedVersions'];
    }
    return ['affectedHeads' => $affected, 'migratedHeads' => $migrated_heads, 'migratedVersions' => $migrated_versions];
}

/** Canonical owners use this in their own transaction after retiring fields. */
function zeroy_localization_reconcile_subject_overlay_heads(array $subject, array $schema): array|WP_Error
{
    global $wpdb;
    $subject = zeroy_localization_subject_ref($subject);
    if (is_wp_error($subject)) {
        return $subject;
    }
    $affected = [];
    foreach ($wpdb->get_results($wpdb->prepare('SELECT * FROM ' . zeroy_runtime_table('locale_overlay_heads') . ' WHERE subject_key = %s', zeroy_localization_subject_key($subject)), ARRAY_A) ?: [] as $head) {
        $reconciliation = zeroy_localization_reconciliation_head($head, $schema, true);
        if (is_wp_error($reconciliation)) {
            return $reconciliation;
        }
        if (!$reconciliation['requiresUpdate']) {
            continue;
        }
        $written = zeroy_localization_write_reconciled_head($reconciliation);
        if (is_wp_error($written)) {
            return $written;
        }
        $affected[] = $written;
    }
    return $affected;
}
