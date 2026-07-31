<?php

defined('ABSPATH') || exit;

function zeroy_localization_legacy_table_exists(string $name): bool
{
    global $wpdb;
    $table = zeroy_runtime_table($name);
    return $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;
}

function zeroy_localization_legacy_document(array $head, string $pointer): array|WP_Error
{
    $version_id = $head[$pointer] ?? null;
    if ($version_id === null) {
        return zeroy_runtime_error('zeroy_legacy_locale_corrupt', "Legacy LocaleHead has no {$pointer}.", 409);
    }
    global $wpdb;
    $row = $wpdb->get_row(
        $wpdb->prepare('SELECT document_json FROM ' . zeroy_runtime_table('locale_versions') . ' WHERE version_id = %d', $version_id),
        ARRAY_A
    );
    $document = is_array($row) ? zeroy_runtime_decode_json((string) $row['document_json']) : zeroy_runtime_error('zeroy_legacy_locale_corrupt', 'Legacy LocaleVersion is missing.', 409);
    return is_wp_error($document) || !is_array($document)
        ? zeroy_runtime_error('zeroy_legacy_locale_corrupt', 'Legacy LocaleVersion document is invalid.', 409)
        : $document;
}

function zeroy_localization_legacy_field_path(array $field): string
{
    return '/' . implode('/', array_map(static fn(mixed $part): string => zeroy_localization_pointer_segment((string) $part), $field['viewPath']));
}

function zeroy_localization_legacy_set_existing_value(mixed &$value, array $path, mixed $override): true|WP_Error
{
    $cursor =& $value;
    foreach ($path as $index => $part) {
        if (!is_array($cursor) || !array_key_exists($part, $cursor)) {
            return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion override no longer matches the canonical ACF shape.', 409, ['path' => '/' . implode('/', $path)]);
        }
        if ($index === count($path) - 1) {
            $cursor[$part] = $override;
            return true;
        }
        $cursor =& $cursor[$part];
    }
    return zeroy_runtime_error('zeroy_legacy_locale_shape_changed', 'A legacy LocaleVersion override has no target path.', 409);
}

function zeroy_localization_legacy_field_override(array $document, array $field): array|WP_Error
{
    $decisions = $document['decisions'] ?? [];
    if (!zeroy_runtime_is_keyed_map($decisions)) {
        return zeroy_runtime_error('zeroy_legacy_locale_corrupt', 'Legacy LocaleVersion decisions must be a keyed object.', 409);
    }
    $path = zeroy_localization_legacy_field_path($field);
    $exact = $decisions[$path] ?? null;
    $descendants = [];
    foreach ($decisions as $candidate_path => $decision) {
        if (!is_string($candidate_path) || !str_starts_with($candidate_path, $path . '/')) {
            continue;
        }
        if (is_array($decision) && ($decision['mode'] ?? null) === 'override' && array_key_exists('value', $decision)) {
            $descendants[$candidate_path] = $decision['value'];
        }
    }
    if (is_array($exact) && ($exact['mode'] ?? null) === 'override' && array_key_exists('value', $exact)) {
        if ($descendants !== []) {
            return zeroy_runtime_error('zeroy_legacy_locale_ambiguous', 'Legacy LocaleVersion contains both a field override and nested overrides.', 409, ['path' => $path]);
        }
        return ['found' => true, 'value' => $exact['value']];
    }
    if ($descendants === []) {
        return ['found' => false];
    }

    $value = $field['value'];
    foreach ($descendants as $candidate_path => $override) {
        $parts = zeroy_localization_pointer_parts(substr($candidate_path, strlen($path)));
        if (is_wp_error($parts)) {
            return $parts;
        }
        $storage_path = zeroy_localization_legacy_acf_storage_path($field, $parts, $value);
        if (is_wp_error($storage_path)) {
            return $storage_path;
        }
        $set = zeroy_localization_legacy_set_existing_value($value, $storage_path, $override);
        if (is_wp_error($set)) {
            return $set;
        }
    }
    return ['found' => true, 'value' => $value];
}

function zeroy_localization_legacy_overlay(array $document, array $fields, array $subject, string $locale, string $policy_hash, string $created_at): array|WP_Error
{
    $template_content = zeroy_localization_legacy_template_content_overlay_values($document, $fields);
    if (is_wp_error($template_content)) {
        return $template_content;
    }
    $values = [];
    foreach ($fields as $field_id => $field) {
        if (!in_array($field['policy']['mode'], ['translated', 'overridable'], true)) {
            continue;
        }
        if (($field['viewPath'][0] ?? null) === 'templateContent') {
            $key = $field['viewPath'][1] ?? null;
            if (!is_string($key) || !array_key_exists($key, $template_content)) {
                continue;
            }
            $values[$field_id] = ['sourceHash' => $field['sourceHash'], 'value' => $template_content[$key]];
            continue;
        }
        $legacy = zeroy_localization_legacy_field_override($document, $field);
        if (is_wp_error($legacy)) {
            return $legacy;
        }
        if (!$legacy['found']) {
            continue;
        }
        $values[$field_id] = ['sourceHash' => $field['sourceHash'], 'value' => $legacy['value']];
    }
    return ['contract' => zeroy_localization_overlay_contract(), 'subject' => $subject, 'locale' => $locale, 'policyHash' => $policy_hash, 'values' => $values, 'createdAt' => $created_at];
}
