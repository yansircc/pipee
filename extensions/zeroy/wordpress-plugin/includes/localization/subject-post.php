<?php

defined('ABSPATH') || exit;

function zeroy_localization_acf_child_value(array $field, mixed $row): mixed
{
    if (!is_array($row)) {
        return null;
    }
    $key = (string) ($field['key'] ?? '');
    $name = (string) ($field['name'] ?? '');
    return $key !== '' && array_key_exists($key, $row)
        ? $row[$key]
        : ($name !== '' && array_key_exists($name, $row) ? $row[$name] : null);
}

function zeroy_localization_acf_scalar(
    array $field,
    mixed $value,
    string $field_id,
    string $label,
    array $view_path
): array {
    return [
        'view' => $value,
        'fields' => [zeroy_localization_field(
            $field_id,
            $label,
            'acf:' . (string) ($field['type'] ?? 'unknown'),
            $value,
            $view_path
        )],
    ];
}

function zeroy_localization_acf_item_key(array $field, array $row, string $item_key_field): string|WP_Error
{
    $candidate = null;
    foreach (is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [] as $sub_field) {
        if (($sub_field['key'] ?? null) === $item_key_field || ($sub_field['name'] ?? null) === $item_key_field) {
            $candidate = zeroy_localization_acf_child_value($sub_field, $row);
            break;
        }
    }
    if ((!is_string($candidate) && !is_int($candidate)) || trim((string) $candidate) === '') {
        return zeroy_runtime_error('zeroy_localization_item_key_missing', "ACF collection {$field['key']} needs a non-empty stable itemKey field {$item_key_field}.", 409);
    }
    return (string) $candidate;
}

function zeroy_localization_acf_field(
    array $field,
    mixed $raw,
    string $field_id,
    string $label,
    array $view_path,
    array $repeater_item_keys
): array|WP_Error {
    $type = (string) ($field['type'] ?? '');
    $name = (string) ($field['name'] ?? '');
    $sub_fields = is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];

    if ($type === 'group') {
        $view = [];
        $fields = [];
        foreach ($sub_fields as $sub_field) {
            $sub_name = (string) ($sub_field['name'] ?? '');
            $sub_key = (string) ($sub_field['key'] ?? '');
            if ($sub_name === '' || $sub_key === '') {
                return zeroy_runtime_error('zeroy_localization_acf_invalid', "ACF group {$field_id} has a child without a stable field key.", 409);
            }
            $child = zeroy_localization_acf_field(
                $sub_field,
                zeroy_localization_acf_child_value($sub_field, $raw),
                $field_id . '/' . zeroy_localization_pointer_segment($sub_key),
                $label . ' / ' . (string) ($sub_field['label'] ?? $sub_name),
                [...$view_path, $sub_name],
                $repeater_item_keys
            );
            if (is_wp_error($child)) {
                return $child;
            }
            $view[$sub_name] = $child['view'];
            $fields = [...$fields, ...$child['fields']];
        }
        return ['view' => $view, 'fields' => $fields];
    }

    if ($type === 'repeater' || $type === 'flexible_content') {
        $rows = is_array($raw) ? $raw : [];
        $item_key_field = $repeater_item_keys[$field_id] ?? null;
        if (!is_string($item_key_field) || $item_key_field === '') {
            // A collection without a stable identity is one canonical field. It
            // may be shared or translated as a whole but can never masquerade
            // as individually localizable rows.
            return zeroy_localization_acf_scalar($field, $rows, $field_id, $label, $view_path);
        }
        $view = [];
        $fields = [];
        $seen_item_keys = [];
        $layouts = [];
        if ($type === 'flexible_content') {
            foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) {
                if (is_string($layout['name'] ?? null)) {
                    $layouts[$layout['name']] = $layout;
                }
            }
        }
        foreach ($rows as $index => $row) {
            if (!is_array($row)) {
                return zeroy_runtime_error('zeroy_localization_collection_invalid', "ACF collection {$field_id} has a non-object row.", 409);
            }
            $row_field = $field;
            $row_label = $label;
            if ($type === 'flexible_content') {
                $layout_name = $row['acf_fc_layout'] ?? null;
                if (!is_string($layout_name) || !isset($layouts[$layout_name])) {
                    return zeroy_runtime_error('zeroy_localization_layout_invalid', "ACF flexible content {$field_id} has an unknown layout.", 409);
                }
                $row_field = [...$field, 'sub_fields' => $layouts[$layout_name]['sub_fields'] ?? []];
                $row_label .= ' / ' . $layout_name;
            }
            $item_key = zeroy_localization_acf_item_key($row_field, $row, $item_key_field);
            if (is_wp_error($item_key)) {
                return $item_key;
            }
            if (isset($seen_item_keys[$item_key])) {
                return zeroy_runtime_error('zeroy_localization_item_key_duplicate', "ACF collection {$field_id} repeats stable itemKey {$item_key}.", 409);
            }
            $seen_item_keys[$item_key] = true;
            $normalized_row = $type === 'flexible_content' ? ['acf_fc_layout' => $row['acf_fc_layout']] : [];
            foreach (is_array($row_field['sub_fields'] ?? null) ? $row_field['sub_fields'] : [] as $sub_field) {
                $sub_name = (string) ($sub_field['name'] ?? '');
                $sub_key = (string) ($sub_field['key'] ?? '');
                if ($sub_name === '' || $sub_key === '') {
                    return zeroy_runtime_error('zeroy_localization_acf_invalid', "ACF collection {$field_id} has a child without a stable field key.", 409);
                }
                $child = zeroy_localization_acf_field(
                    $sub_field,
                    zeroy_localization_acf_child_value($sub_field, $row),
                    $field_id . '/' . zeroy_localization_pointer_segment($item_key) . '/' . zeroy_localization_pointer_segment($sub_key),
                    $row_label . ' / ' . ($index + 1) . ' / ' . (string) ($sub_field['label'] ?? $sub_name),
                    [...$view_path, $index, $sub_name],
                    $repeater_item_keys
                );
                if (is_wp_error($child)) {
                    return $child;
                }
                $normalized_row[$sub_name] = $child['view'];
                $fields = [...$fields, ...$child['fields']];
            }
            $view[] = $normalized_row;
        }
        return ['view' => $view, 'fields' => $fields];
    }

    return zeroy_localization_acf_scalar($field, $raw, $field_id, $label, $view_path);
}

function zeroy_localization_post_subject(int $post_id, ?array $definition_override = null): array|WP_Error
{
    $canonical = zeroy_runtime_canonical($post_id);
    if (is_wp_error($canonical)) {
        return $canonical;
    }
    $definition = $definition_override ?? zeroy_runtime_schema_definition((string) $canonical['schemaId']);
    if (is_wp_error($definition)) {
        return $definition;
    }
    $policy = zeroy_localization_compiled_policy($definition);
    if (is_wp_error($policy)) {
        return $policy;
    }
    $post = $canonical['post'];
    $fields = [
        zeroy_localization_field('/post/title', 'WordPress title', 'post:title', $post->post_title, ['post', 'title']),
        zeroy_localization_field('/post/content', 'WordPress content', 'post:content', $post->post_content, ['post', 'content']),
        zeroy_localization_field('/post/excerpt', 'WordPress excerpt', 'post:excerpt', $post->post_excerpt, ['post', 'excerpt']),
    ];
    $view = [
        'post' => ['title' => $post->post_title, 'content' => $post->post_content, 'excerpt' => $post->post_excerpt],
        'acf' => [],
        'templateContent' => [],
    ];
    if (function_exists('acf_get_field_groups') && function_exists('acf_get_fields') && function_exists('get_field')) {
        $seen_keys = [];
        foreach (acf_get_field_groups(['post_id' => $post_id]) as $group) {
            foreach (is_array(acf_get_fields($group)) ? acf_get_fields($group) : [] as $field) {
                $name = (string) ($field['name'] ?? '');
                $key = (string) ($field['key'] ?? '');
                if ($name === '' || $key === '') {
                    return zeroy_runtime_error('zeroy_localization_acf_invalid', 'Applicable ACF fields require stable names and keys.', 409);
                }
                if (isset($seen_keys[$key])) {
                    return zeroy_runtime_error('zeroy_localization_field_collision', "Applicable ACF fields collide at {$key}.", 409);
                }
                $seen_keys[$key] = true;
                $projection = zeroy_localization_acf_field(
                    $field,
                    get_field($key, $post_id, false),
                    '/acf/' . zeroy_localization_pointer_segment($key),
                    (string) ($field['label'] ?? $name),
                    ['acf', $name],
                    $policy['repeaterItemKeys']
                );
                if (is_wp_error($projection)) {
                    return $projection;
                }
                $view['acf'][$name] = $projection['view'];
                $fields = [...$fields, ...$projection['fields']];
            }
        }
    }
    $template_content = zeroy_localization_template_content_projection($post_id, $definition);
    if (is_wp_error($template_content)) {
        return $template_content;
    }
    $view['templateContent'] = $template_content['view'];
    $fields = [...$fields, ...$template_content['fields']];
    usort($fields, static fn(array $left, array $right): int => strcmp($left['fieldId'], $right['fieldId']));
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => ['kind' => 'post', 'id' => $post_id],
        'schemaId' => $canonical['schemaId'],
        'canonicalRevision' => zeroy_runtime_hash([
            'metaRevision' => $canonical['revision'],
            'fields' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields),
        ]),
        'fields' => $fields,
        'view' => $view,
    ];
}
