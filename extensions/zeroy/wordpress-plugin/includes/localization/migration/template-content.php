<?php

defined('ABSPATH') || exit;

/**
 * Legacy template nodes become either default-locale canonical post meta or
 * non-default LocaleOverlay values. This is a transition writer, never a
 * request-time legacy reader.
 */
function zeroy_localization_legacy_template_content_values(array $document, array $definition): array|WP_Error
{
    $nodes = $document['nodes'] ?? null;
    $declared = $definition['templateContent'] ?? null;
    if (!zeroy_runtime_is_keyed_map($nodes) || !zeroy_runtime_is_keyed_map($declared)) {
        return zeroy_runtime_error('zeroy_legacy_template_content_invalid', 'Legacy template nodes or the candidate TemplateContent declaration are invalid.', 409);
    }
    $values = [];
    foreach ($nodes as $key => $value) {
        if (!is_string($key) || !array_key_exists($key, $declared) || !is_string($value)) {
            return zeroy_runtime_error('zeroy_legacy_template_content_unmapped', 'A legacy template node cannot be represented by the candidate TemplateContent declaration.', 409, ['key' => is_string($key) ? $key : null]);
        }
        $values[$key] = $value;
    }
    return $values;
}

function zeroy_localization_legacy_template_content_overlay_values(array $document, array $fields): array|WP_Error
{
    $nodes = $document['nodes'] ?? null;
    if (!zeroy_runtime_is_keyed_map($nodes)) {
        return zeroy_runtime_error('zeroy_legacy_template_content_invalid', 'Legacy template nodes are invalid.', 409);
    }
    $allowed = [];
    foreach ($fields as $field) {
        if (($field['viewPath'][0] ?? null) === 'templateContent' && is_string($field['viewPath'][1] ?? null)) {
            $allowed[$field['viewPath'][1]] = true;
        }
    }
    foreach ($nodes as $key => $value) {
        if (!is_string($key) || !isset($allowed[$key]) || !is_string($value)) {
            return zeroy_runtime_error('zeroy_legacy_template_content_unmapped', 'A legacy template node cannot be represented by the candidate TemplateContent declaration.', 409, ['key' => is_string($key) ? $key : null]);
        }
    }
    return $nodes;
}

function zeroy_localization_legacy_default_template_content(array $document, int $post_id, array $definition): array|WP_Error
{
    $legacy = zeroy_localization_legacy_template_content_values($document, $definition);
    if (is_wp_error($legacy)) {
        return $legacy;
    }
    $current = zeroy_localization_template_content_values($post_id, $definition);
    if (is_wp_error($current)) {
        return $current;
    }
    foreach ($legacy as $key => $value) {
        if ($current[$key] !== '' && $current[$key] !== $value) {
            return zeroy_runtime_error('zeroy_legacy_template_content_conflict', 'Legacy template content conflicts with an existing canonical WordPress value.', 409, ['objectId' => $post_id, 'key' => $key]);
        }
        $current[$key] = $value;
    }
    return $current;
}

function zeroy_localization_apply_legacy_default_template_content(array $document, int $post_id, array $definition): true|WP_Error
{
    $values = zeroy_localization_legacy_default_template_content($document, $post_id, $definition);
    return is_wp_error($values)
        ? $values
        : zeroy_localization_replace_template_content($post_id, $values, $definition);
}
