<?php

defined('ABSPATH') || exit;

/**
 * The retired document model addressed ACF by display names while raw ACF
 * values use field keys. This one-shot adapter converts only legacy paths;
 * LocalizableSubject identity remains field-key based at runtime.
 */
function zeroy_localization_legacy_acf_child(array $fields, string $name): ?array
{
    foreach ($fields as $field) {
        if (is_array($field) && ($field['name'] ?? null) === $name) {
            return $field;
        }
    }
    return null;
}
function zeroy_localization_legacy_acf_storage_key(array $field, array $value): string|WP_Error
{
    $key = is_string($field['key'] ?? null) ? $field['key'] : '';
    $name = is_string($field['name'] ?? null) ? $field['name'] : '';
    if ($key !== '' && array_key_exists($key, $value)) {
        return $key;
    }
    if ($name !== '' && array_key_exists($name, $value)) {
        return $name;
    }
    return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion field is absent from the canonical ACF value.', 409, ['field' => $name]);
}

function zeroy_localization_legacy_acf_storage_path(array $field, array $legacy_path, mixed $value): array|WP_Error
{
    $field_parts = zeroy_localization_pointer_parts((string) $field['fieldId']);
    if (is_wp_error($field_parts) || ($field_parts[0] ?? null) !== 'acf' || !function_exists('acf_get_field')) {
        return $legacy_path;
    }
    $definition = acf_get_field((string) ($field_parts[1] ?? ''));
    if (!is_array($definition)) {
        return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'Legacy LocaleVersion refers to an unavailable ACF field definition.', 409, ['fieldId' => $field['fieldId']]);
    }
    $cursor = $value;
    $storage = [];
    $children = [];
    foreach ($legacy_path as $segment) {
        if (ctype_digit($segment)) {
            if (!in_array($definition['type'] ?? null, ['repeater', 'flexible_content'], true) || !is_array($cursor) || !array_key_exists((int) $segment, $cursor)) {
                return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion collection index no longer matches the canonical ACF shape.', 409, ['fieldId' => $field['fieldId'], 'segment' => $segment]);
            }
            $storage[] = $segment;
            $cursor = $cursor[(int) $segment];
            if (!is_array($cursor)) {
                return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion collection row is not an ACF object.', 409, ['fieldId' => $field['fieldId'], 'segment' => $segment]);
            }
            $children = is_array($definition['sub_fields'] ?? null) ? $definition['sub_fields'] : [];
            if (($definition['type'] ?? null) === 'flexible_content') {
                $layout_name = $cursor['acf_fc_layout'] ?? null;
                $layout = null;
                foreach (is_array($definition['layouts'] ?? null) ? $definition['layouts'] : [] as $candidate) {
                    if (is_array($candidate) && ($candidate['name'] ?? null) === $layout_name) {
                        $layout = $candidate;
                        break;
                    }
                }
                if (!is_array($layout)) {
                    return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion flexible-content layout no longer matches the canonical ACF shape.', 409, ['fieldId' => $field['fieldId'], 'segment' => $segment]);
                }
                $children = is_array($layout['sub_fields'] ?? null) ? $layout['sub_fields'] : [];
            }
            continue;
        }
        if (($definition['type'] ?? null) === 'group' && $children === []) {
            $children = is_array($definition['sub_fields'] ?? null) ? $definition['sub_fields'] : [];
        }
        $child = zeroy_localization_legacy_acf_child($children, $segment);
        if (!is_array($child) || !is_array($cursor)) {
            return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion field no longer matches the canonical ACF shape.', 409, ['fieldId' => $field['fieldId'], 'segment' => $segment]);
        }
        $key = zeroy_localization_legacy_acf_storage_key($child, $cursor);
        if (is_wp_error($key)) {
            return $key;
        }
        $storage[] = $key;
        $cursor = $cursor[$key];
        $definition = $child;
        $children = [];
    }
    return $storage;
}
