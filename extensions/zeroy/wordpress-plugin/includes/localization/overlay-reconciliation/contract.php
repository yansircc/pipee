<?php

defined('ABSPATH') || exit;

/**
 * Reconciliation is the sole bridge from one active ThemeSchema policy to the
 * next. It preserves immutable LocaleOverlay history and only produces a
 * replacement overlay for a later transactional pointer move.
 */
function zeroy_localization_candidate_definition(array $schema, array $head, array $subject): array|WP_Error
{
    if ($subject['kind'] === 'post') {
        $definition = $schema['schemas'][$head['schema_id'] ?? ''] ?? null;
    } else {
        $key = $subject['kind'] === 'site-copy' ? 'siteCopy' : $subject['kind'];
        $definition = $schema['localizationSubjects'][$key] ?? null;
    }
    return is_array($definition)
        ? $definition
        : zeroy_runtime_error('zeroy_localization_definition_missing', 'The candidate ThemeSchema no longer defines this LocalizableSubject.', 409, [
            'subjectKey' => $head['subject_key'] ?? null,
            'locale' => $head['locale'] ?? null,
        ]);
}

function zeroy_localization_subject_for_candidate_definition(array $subject, array $definition): array|WP_Error
{
    return $subject['kind'] === 'post'
        ? zeroy_localization_post_subject((int) $subject['id'], $definition)
        : zeroy_localization_subject($subject);
}

function zeroy_localization_overlay_matches_head(array $overlay, array $subject, string $locale): true|WP_Error
{
    $overlay_subject = zeroy_localization_subject_ref($overlay['subject'] ?? null);
    if (is_wp_error($overlay_subject) || !hash_equals(zeroy_runtime_hash($subject), zeroy_runtime_hash($overlay_subject))) {
        return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay belongs to a different LocalizableSubject.', 409);
    }
    return ($overlay['locale'] ?? null) === $locale
        ? true
        : zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay belongs to a different locale.', 409);
}

/**
 * A policy can retire fields from locale ownership. They are deliberately not
 * copied to the next version; old immutable versions retain the audit trail.
 */
function zeroy_localization_reconcile_overlay(
    array $overlay,
    array $fields,
    array $subject,
    string $locale,
    string $policy_hash,
    bool $prune_unavailable = false
): array|WP_Error {
    $identity = zeroy_localization_overlay_matches_head($overlay, $subject, $locale);
    if (is_wp_error($identity)) {
        return $identity;
    }
    $policy_changed = !hash_equals($policy_hash, (string) ($overlay['policyHash'] ?? ''));
    $values = [];
    $discarded = [];
    foreach ($overlay['values'] as $field_id => $stored) {
        if (!is_string($field_id) || !is_array($stored) || !array_key_exists('value', $stored) || !is_string($stored['sourceHash'] ?? null)) {
            return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay contains a malformed localized field.', 409, ['fieldId' => is_string($field_id) ? $field_id : null]);
        }
        $field = $fields[$field_id] ?? null;
        $writable = is_array($field) && in_array($field['policy']['mode'] ?? null, ['translated', 'overridable'], true);
        if (!$writable) {
            if (!$policy_changed && !$prune_unavailable) {
                return zeroy_runtime_error('zeroy_locale_overlay_corrupt', 'LocaleOverlay contains a field unavailable to the active LocalizationPolicy.', 409, ['fieldId' => $field_id]);
            }
            $discarded[] = $field_id;
            continue;
        }
        $values[$field_id] = $stored;
    }
    return [
        'policyChanged' => $policy_changed,
        'requiresNewVersion' => $policy_changed || $discarded !== [],
        'discardedFields' => $discarded,
        'overlay' => [
            ...$overlay,
            'policyHash' => $policy_hash,
            'values' => $values,
            'createdAt' => current_time('mysql', true),
        ],
    ];
}
