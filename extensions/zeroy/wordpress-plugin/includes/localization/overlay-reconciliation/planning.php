<?php

defined('ABSPATH') || exit;

function zeroy_localization_reconciliation_head(array $head, array $schema, bool $prune_unavailable = false): array|WP_Error
{
    $subject = zeroy_runtime_decode_json((string) ($head['subject_json'] ?? ''));
    if (is_wp_error($subject)) {
        return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleHead subject is invalid.', 409, ['subjectKey' => $head['subject_key'] ?? null]);
    }
    $subject = zeroy_localization_subject_ref($subject);
    if (is_wp_error($subject) || !hash_equals((string) ($head['subject_key'] ?? ''), zeroy_localization_subject_key($subject))) {
        return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleHead subject identity is invalid.', 409, ['subjectKey' => $head['subject_key'] ?? null]);
    }
    $definition = zeroy_localization_candidate_definition($schema, $head, $subject);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $localizable = zeroy_localization_subject_for_candidate_definition($subject, $definition);
    if (is_wp_error($localizable)) {
        return $localizable;
    }
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    if (is_wp_error($compiled)) {
        return $compiled;
    }
    $route = zeroy_localization_subject_route($subject, $definition);
    if (is_wp_error($route)) {
        return $route;
    }
    $pointers = [];
    $migrated_pointers = [];
    $discarded_fields = [];
    foreach (['draft_version_id', 'published_version_id'] as $pointer) {
        if ($head[$pointer] === null) {
            $pointers[$pointer] = null;
            continue;
        }
        $version_id = (int) $head[$pointer];
        $version = zeroy_localization_overlay_version($version_id);
        $overlay = $version === null
            ? zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleHead points to a missing immutable LocaleOverlay.', 409, ['pointer' => $pointer])
            : zeroy_localization_decode_overlay($version);
        if (is_wp_error($overlay)) {
            return $overlay;
        }
        $reconciled = zeroy_localization_reconcile_overlay($overlay, $compiled['fields'], $subject, (string) $head['locale'], $compiled['policy']['hash'], $prune_unavailable);
        if (is_wp_error($reconciled)) {
            return $reconciled;
        }
        $pointers[$pointer] = ['sourceVersionId' => $version_id, ...$reconciled];
        if ($reconciled['requiresNewVersion']) {
            $migrated_pointers[] = $pointer;
            $discarded_fields = [...$discarded_fields, ...$reconciled['discardedFields']];
        }
    }
    $route_changed = !hash_equals((string) $head['route_path'], $route);
    return [
        'head' => $head,
        'subject' => $subject,
        'policyHash' => $compiled['policy']['hash'],
        'route' => $route,
        'pointers' => $pointers,
        'requiresUpdate' => $migrated_pointers !== [] || $route_changed,
        'summary' => [
            'state' => $migrated_pointers !== [] ? 'would-migrate' : 'would-update-route',
            'subjectKey' => $head['subject_key'],
            'locale' => $head['locale'],
            'pointers' => $migrated_pointers,
            'routeChanged' => $route_changed,
            'discardedFields' => array_values(array_unique($discarded_fields)),
        ],
    ];
}

function zeroy_localization_plan_overlay_reconciliation(array $schema, array $retired_subject_keys = []): array
{
    global $wpdb;
    $affected = [];
    $blockers = [];
    foreach ($wpdb->get_results('SELECT * FROM ' . zeroy_runtime_table('locale_overlay_heads'), ARRAY_A) ?: [] as $head) {
        if (isset($retired_subject_keys[(string) ($head['subject_key'] ?? '')])) continue;
        $reconciliation = zeroy_localization_reconciliation_head($head, $schema);
        if (is_wp_error($reconciliation)) {
            $blockers[] = [
                'state' => 'incompatible',
                'subjectKey' => $head['subject_key'],
                'locale' => $head['locale'],
                'code' => $reconciliation->get_error_code(),
                'message' => $reconciliation->get_error_message(),
            ];
            continue;
        }
        if ($reconciliation['requiresUpdate']) {
            $affected[] = $reconciliation['summary'];
        }
    }
    return [
        'affectedHeads' => $affected,
        'blockingHeads' => $blockers,
        'migratedHeads' => 0,
        'migratedVersions' => 0,
        'ok' => $blockers === [],
    ];
}
