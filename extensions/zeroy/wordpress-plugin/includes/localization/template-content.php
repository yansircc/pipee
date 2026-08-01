<?php

defined('ABSPATH') || exit;

/**
 * Default-locale TemplateContent is a canonical WordPress post-meta fact.
 * The schema only declares its shape; no value lives in the ThemeArtifact.
 */
function zeroy_localization_template_content_values(int $post_id, array $definition): array|WP_Error
{
    $declared = $definition['templateContent'] ?? [];
    if (!zeroy_runtime_is_keyed_map($declared)) {
        return zeroy_runtime_error('zeroy_template_content_schema_invalid', 'TemplateContent declaration is invalid.', 409);
    }
    $stored = get_post_meta($post_id, ZEROY_RUNTIME_TEMPLATE_CONTENT_META, true);
    if ($stored === '') {
        $stored = [];
    }
    if (!zeroy_runtime_is_keyed_map($stored)) {
        return zeroy_runtime_error('zeroy_template_content_invalid', 'Canonical TemplateContent must be a keyed object.', 409, ['objectId' => $post_id]);
    }
    foreach ($stored as $key => $value) {
        if (!is_string($key) || !array_key_exists($key, $declared) || !is_string($value)) {
            return zeroy_runtime_error('zeroy_template_content_invalid', 'Canonical TemplateContent contains an undeclared or non-text field.', 409, ['objectId' => $post_id, 'key' => is_string($key) ? $key : null]);
        }
    }
    $values = [];
    foreach ($declared as $key => $_field) {
        $values[$key] = is_string($stored[$key] ?? null) ? $stored[$key] : '';
    }
    return $values;
}

function zeroy_localization_replace_template_content(int $post_id, array $values, array $definition): true|WP_Error
{
    $declared = $definition['templateContent'] ?? [];
    if (!zeroy_runtime_is_keyed_map($values) || !zeroy_runtime_is_keyed_map($declared)) {
        return zeroy_runtime_error('zeroy_template_content_invalid', 'TemplateContent replacement requires keyed values and a valid declaration.', 409);
    }
    foreach ($values as $key => $value) {
        if (!is_string($key) || !array_key_exists($key, $declared) || !is_string($value)) {
            return zeroy_runtime_error('zeroy_template_content_invalid', 'TemplateContent replacement contains an undeclared or non-text field.', 409, ['objectId' => $post_id, 'key' => is_string($key) ? $key : null]);
        }
    }
    $current = get_post_meta($post_id, ZEROY_RUNTIME_TEMPLATE_CONTENT_META, true);
    $current = $current === '' ? [] : $current;
    if (zeroy_runtime_is_keyed_map($current) && zeroy_runtime_hash($current) === zeroy_runtime_hash($values)) {
        return true;
    }
    return update_post_meta($post_id, ZEROY_RUNTIME_TEMPLATE_CONTENT_META, $values) !== false
        ? true
        : zeroy_runtime_error('zeroy_template_content_write_failed', 'Could not persist canonical TemplateContent.', 500, ['objectId' => $post_id]);
}

function zeroy_localization_template_content_required_violations(array $values, array $definition): array
{
    $violations = [];
    foreach ($definition['templateContent'] ?? [] as $key => $declaration) {
        if (!is_string($key) || !is_array($declaration)) {
            continue;
        }
        $policy = $declaration['localization'] ?? null;
        if (!is_array($policy) || ($policy['required'] ?? false) !== true) {
            continue;
        }
        if (!zeroy_localization_value_is_present($values[$key] ?? null)) {
            $violations[] = ['fieldId' => '/template-content/' . zeroy_localization_pointer_segment($key), 'key' => $key];
        }
    }
    return $violations;
}

function zeroy_localization_template_content_field(string $key, string $value, array $declaration): array
{
    $field_id = '/template-content/' . zeroy_localization_pointer_segment($key);
    return [
        ...zeroy_localization_field($field_id, $key, 'template-content:text', $value, ['templateContent', $key]),
        'localization' => $declaration['localization'],
        'searchable' => $declaration['searchable'],
    ];
}

function zeroy_localization_template_content_projection(int $post_id, array $definition): array|WP_Error
{
    $values = zeroy_localization_template_content_values($post_id, $definition);
    if (is_wp_error($values)) {
        return $values;
    }
    $fields = [];
    foreach ($definition['templateContent'] ?? [] as $key => $declaration) {
        $fields[] = zeroy_localization_template_content_field($key, $values[$key], $declaration);
    }
    return ['view' => $values, 'fields' => $fields];
}
