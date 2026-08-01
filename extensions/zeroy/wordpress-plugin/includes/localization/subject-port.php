<?php

defined('ABSPATH') || exit;

/**
 * LocalizableSubject is the only canonical-data boundary.  Adapters return
 * stable field identities plus request-local view paths; the latter are never
 * persisted and therefore cannot become a second identity system.
 */
function zeroy_localization_pointer_segment(string $segment): string
{
    return str_replace(['~', '/'], ['~0', '~1'], $segment);
}

function zeroy_localization_pointer_parts(string $pointer): array|WP_Error
{
    if ($pointer === '' || $pointer[0] !== '/') {
        return zeroy_runtime_error('zeroy_localization_field_invalid', 'Localization fieldId must be a JSON pointer.', 400);
    }

    return array_map(
        static fn(string $part): string => str_replace(['~1', '~0'], ['/', '~'], $part),
        explode('/', substr($pointer, 1))
    );
}

function zeroy_localization_subject_ref(mixed $subject): array|WP_Error
{
    if (!is_array($subject) || array_is_list($subject) || !is_string($subject['kind'] ?? null)) {
        return zeroy_runtime_error('zeroy_translation_subject_invalid', 'subject must be a typed LocalizableSubject reference.', 400);
    }

    if ($subject['kind'] === 'post' || $subject['kind'] === 'media' || $subject['kind'] === 'menu') {
        $id = $subject['id'] ?? null;
        if ((!is_int($id) && !(is_string($id) && ctype_digit($id))) || (int) $id < 1) {
            return zeroy_runtime_error('zeroy_translation_subject_invalid', "{$subject['kind']} subject needs a positive numeric id.", 400);
        }
        return ['kind' => $subject['kind'], 'id' => (int) $id];
    }

    if ($subject['kind'] === 'term') {
        $id = $subject['id'] ?? null;
        $taxonomy = $subject['taxonomy'] ?? null;
        if ((!is_int($id) && !(is_string($id) && ctype_digit($id))) || (int) $id < 1 || !is_string($taxonomy) || $taxonomy === '') {
            return zeroy_runtime_error('zeroy_translation_subject_invalid', 'term subject needs taxonomy and a positive numeric id.', 400);
        }
        return ['kind' => 'term', 'taxonomy' => $taxonomy, 'id' => (int) $id];
    }

    if ($subject['kind'] === 'site-copy' && ($subject['id'] ?? null) === 'default') {
        return ['kind' => 'site-copy', 'id' => 'default'];
    }

    return zeroy_runtime_error('zeroy_translation_subject_invalid', 'Unsupported LocalizableSubject kind.', 400);
}

function zeroy_localization_subject_key(array $subject): string
{
    return match ($subject['kind']) {
        'post', 'media', 'menu' => $subject['kind'] . ':' . (int) $subject['id'],
        'term' => 'term:' . $subject['taxonomy'] . ':' . (int) $subject['id'],
        'site-copy' => 'site-copy:default',
    };
}

function zeroy_localization_field(
    string $field_id,
    string $label,
    string $kind,
    mixed $value,
    array $view_path,
    array $context = []
): array {
    return [
        'fieldId' => $field_id,
        'label' => $label,
        'kind' => $kind,
        'value' => $value,
        'sourceHash' => zeroy_runtime_hash([
            'fieldId' => $field_id,
            'kind' => $kind,
            'value' => $value,
        ]),
        'viewPath' => $view_path,
        ...($context === [] ? [] : ['context' => $context]),
    ];
}

/**
 * `required` is a content invariant, not merely the presence of a key in an
 * Overlay.  In particular, an empty translation must not make a required
 * field publishable.  False and zero remain legitimate canonical values.
 */
function zeroy_localization_value_is_present(mixed $value): bool
{
    if ($value === null) {
        return false;
    }
    if (is_string($value)) {
        return trim($value) !== '';
    }
    if (is_array($value)) {
        return $value !== [];
    }
    return true;
}

function zeroy_localization_subject(array $subject): array|WP_Error
{
    $subject = zeroy_localization_subject_ref($subject);
    if (is_wp_error($subject)) {
        return $subject;
    }

    return match ($subject['kind']) {
        'post' => zeroy_localization_post_subject((int) $subject['id']),
        'term' => zeroy_localization_term_subject((string) $subject['taxonomy'], (int) $subject['id']),
        'menu' => zeroy_localization_menu_subject((int) $subject['id']),
        'site-copy' => zeroy_localization_site_copy_subject(),
        'media' => zeroy_localization_media_subject((int) $subject['id']),
    };
}

function zeroy_localization_field_map(array $subject): array|WP_Error
{
    $map = [];
    foreach ($subject['fields'] ?? [] as $field) {
        if (!is_array($field) || !is_string($field['fieldId'] ?? null)) {
            return zeroy_runtime_error('zeroy_localization_subject_invalid', 'LocalizableSubject returned an invalid field.', 500);
        }
        if (isset($map[$field['fieldId']])) {
            return zeroy_runtime_error('zeroy_localization_field_collision', "Canonical fields collide at {$field['fieldId']}.", 409);
        }
        $map[$field['fieldId']] = $field;
    }
    return $map;
}

function zeroy_localization_set_view_value(array &$view, array $path, mixed $value): void
{
    $cursor =& $view;
    foreach ($path as $index => $part) {
        if ($index === count($path) - 1) {
            $cursor[$part] = $value;
            return;
        }
        if (!isset($cursor[$part]) || !is_array($cursor[$part])) {
            $cursor[$part] = [];
        }
        $cursor =& $cursor[$part];
    }
}
