<?php

defined('ABSPATH') || exit;

function zeroy_runtime_pointer_segment(string $segment): string
{
    return str_replace(['~', '/'], ['~0', '~1'], $segment);
}

function zeroy_runtime_pointer_parts(string $pointer): array|WP_Error
{
    if ($pointer === '' || $pointer[0] !== '/') {
        return zeroy_runtime_error('zeroy_content_path_invalid', 'Content decision paths must be JSON pointers.', 400);
    }
    return array_map(
        static fn(string $part): string => str_replace(['~1', '~0'], ['/', '~'], $part),
        explode('/', substr($pointer, 1))
    );
}

function zeroy_runtime_content_leaf(string $path, string $label, string $kind, mixed $value, array $identity = []): array
{
    return [
        'path' => $path,
        'label' => $label,
        'kind' => $kind,
        'value' => $value,
        'sourceHash' => zeroy_runtime_hash([
            'path' => $path,
            'kind' => $kind,
            'identity' => $identity,
            'value' => $value,
        ]),
    ];
}

function zeroy_runtime_acf_normalize_value(array $field, mixed $value): mixed
{
    $type = (string) ($field['type'] ?? '');
    $sub_fields = is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];
    if ($type === 'repeater' && is_array($value)) {
        $rows = [];
        foreach ($value as $row) {
            if (!is_array($row)) {
                continue;
            }
            $normalized = [];
            foreach ($sub_fields as $sub_field) {
                $name = (string) ($sub_field['name'] ?? '');
                $key = (string) ($sub_field['key'] ?? '');
                if ($name === '') {
                    continue;
                }
                $child = array_key_exists($key, $row) ? $row[$key] : ($row[$name] ?? null);
                $normalized[$name] = zeroy_runtime_acf_normalize_value($sub_field, $child);
            }
            $rows[] = $normalized;
        }
        return $rows;
    }
    if ($type === 'group' && is_array($value)) {
        $normalized = [];
        foreach ($sub_fields as $sub_field) {
            $name = (string) ($sub_field['name'] ?? '');
            $key = (string) ($sub_field['key'] ?? '');
            if ($name === '') {
                continue;
            }
            $child = array_key_exists($key, $value) ? $value[$key] : ($value[$name] ?? null);
            $normalized[$name] = zeroy_runtime_acf_normalize_value($sub_field, $child);
        }
        return $normalized;
    }
    if ($type === 'flexible_content' && is_array($value)) {
        $layouts = [];
        foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) {
            $layouts[(string) ($layout['name'] ?? '')] = $layout;
        }
        $rows = [];
        foreach ($value as $row) {
            if (!is_array($row)) {
                continue;
            }
            $layout_name = (string) ($row['acf_fc_layout'] ?? '');
            $normalized = ['acf_fc_layout' => $layout_name];
            foreach (is_array($layouts[$layout_name]['sub_fields'] ?? null) ? $layouts[$layout_name]['sub_fields'] : [] as $sub_field) {
                $name = (string) ($sub_field['name'] ?? '');
                $key = (string) ($sub_field['key'] ?? '');
                if ($name === '') {
                    continue;
                }
                $child = array_key_exists($key, $row) ? $row[$key] : ($row[$name] ?? null);
                $normalized[$name] = zeroy_runtime_acf_normalize_value($sub_field, $child);
            }
            $rows[] = $normalized;
        }
        return $rows;
    }
    return $value;
}

function zeroy_runtime_acf_value_leaves(array $field, mixed $value, string $path, string $label): array
{
    $type = (string) ($field['type'] ?? '');
    $identity = ['fieldKey' => (string) ($field['key'] ?? ''), 'fieldType' => $type];
    $sub_fields = is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];
    if ($type === 'repeater' && is_array($value)) {
        $leaves = [];
        foreach ($value as $index => $row) {
            foreach ($sub_fields as $sub_field) {
                $name = (string) ($sub_field['name'] ?? '');
                if ($name === '' || !is_array($row)) {
                    continue;
                }
                $leaves = [...$leaves, ...zeroy_runtime_acf_value_leaves(
                    $sub_field,
                    $row[$name] ?? null,
                    $path . '/' . $index . '/' . zeroy_runtime_pointer_segment($name),
                    $label . ' / ' . ($index + 1) . ' / ' . (string) ($sub_field['label'] ?? $name)
                )];
            }
        }
        return $leaves;
    }
    if ($type === 'group' && is_array($value)) {
        $leaves = [];
        foreach ($sub_fields as $sub_field) {
            $name = (string) ($sub_field['name'] ?? '');
            if ($name === '') {
                continue;
            }
            $leaves = [...$leaves, ...zeroy_runtime_acf_value_leaves(
                $sub_field,
                $value[$name] ?? null,
                $path . '/' . zeroy_runtime_pointer_segment($name),
                $label . ' / ' . (string) ($sub_field['label'] ?? $name)
            )];
        }
        return $leaves;
    }
    if ($type === 'flexible_content' && is_array($value)) {
        $layouts = [];
        foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) {
            $layouts[(string) ($layout['name'] ?? '')] = $layout;
        }
        $leaves = [];
        foreach ($value as $index => $row) {
            if (!is_array($row)) {
                continue;
            }
            $layout_name = (string) ($row['acf_fc_layout'] ?? '');
            foreach (is_array($layouts[$layout_name]['sub_fields'] ?? null) ? $layouts[$layout_name]['sub_fields'] : [] as $sub_field) {
                $name = (string) ($sub_field['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $leaves = [...$leaves, ...zeroy_runtime_acf_value_leaves(
                    $sub_field,
                    $row[$name] ?? null,
                    $path . '/' . $index . '/' . zeroy_runtime_pointer_segment($name),
                    $label . ' / ' . ($index + 1) . ' ' . $layout_name . ' / ' . (string) ($sub_field['label'] ?? $name)
                )];
            }
        }
        return $leaves;
    }
    return [zeroy_runtime_content_leaf($path, $label, 'acf:' . $type, $value, $identity)];
}

function zeroy_runtime_effective_content_tree(int $object_id): array|WP_Error
{
    $post = get_post($object_id);
    if (!$post instanceof WP_Post) {
        return zeroy_runtime_error('zeroy_canonical_missing', "Canonical WordPress object {$object_id} does not exist.", 404);
    }
    $leaves = [
        zeroy_runtime_content_leaf('/post/title', 'WordPress title', 'post:title', $post->post_title),
        zeroy_runtime_content_leaf('/post/content', 'WordPress content', 'post:content', $post->post_content),
        zeroy_runtime_content_leaf('/post/excerpt', 'WordPress excerpt', 'post:excerpt', $post->post_excerpt),
    ];
    $acf = [];
    $groups = [];
    if (function_exists('acf_get_field_groups') && function_exists('acf_get_fields') && function_exists('get_field')) {
        foreach (acf_get_field_groups(['post_id' => $object_id]) as $group) {
            $group_fields = [];
            foreach (is_array(acf_get_fields($group)) ? acf_get_fields($group) : [] as $field) {
                $name = (string) ($field['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                if (array_key_exists($name, $acf)) {
                    return zeroy_runtime_error(
                        'zeroy_acf_path_collision',
                        "Applicable ACF fields collide at /acf/{$name}.",
                        409
                    );
                }
                $raw = get_field($name, $object_id, false);
                $normalized = zeroy_runtime_acf_normalize_value($field, $raw);
                $acf[$name] = $normalized;
                $group_fields[] = zeroy_runtime_acf_field_projection($field);
                $leaves = [...$leaves, ...zeroy_runtime_acf_value_leaves(
                    $field,
                    $normalized,
                    '/acf/' . zeroy_runtime_pointer_segment($name),
                    (string) ($field['label'] ?? $name)
                )];
            }
            $groups[] = [
                'key' => (string) ($group['key'] ?? ''),
                'title' => (string) ($group['title'] ?? ''),
                'fields' => $group_fields,
            ];
        }
    }
    usort($leaves, static fn(array $left, array $right): int => strcmp($left['path'], $right['path']));
    for ($index = 1; $index < count($leaves); $index++) {
        if ($leaves[$index - 1]['path'] === $leaves[$index]['path']) {
            return zeroy_runtime_error(
                'zeroy_content_path_collision',
                'Effective content fields collide at ' . $leaves[$index]['path'] . '.',
                409
            );
        }
    }
    return [
        'contract' => 'zeroy/effective-content-tree@1',
        'objectId' => $object_id,
        'sourceHash' => zeroy_runtime_hash(array_map(static fn(array $leaf): array => [
            'path' => $leaf['path'],
            'sourceHash' => $leaf['sourceHash'],
        ], $leaves)),
        'post' => [
            'title' => $post->post_title,
            'content' => $post->post_content,
            'excerpt' => $post->post_excerpt,
        ],
        'acf' => $acf,
        'fieldGroups' => $groups,
        'leaves' => $leaves,
    ];
}

function zeroy_runtime_decision_violations(array $decisions, array $tree, bool $complete): array
{
    $leaves = [];
    foreach ($tree['leaves'] as $leaf) {
        $leaves[$leaf['path']] = $leaf;
    }
    $violations = [];
    foreach ($decisions as $path => $decision) {
        if (!is_string($path) || !isset($leaves[$path])) {
            $violations[] = ['code' => 'decision_path_unknown', 'path' => $path, 'message' => "Decision path {$path} is not in the current effective content tree."];
            continue;
        }
        if (!is_array($decision) || !in_array($decision['mode'] ?? null, ['inherit', 'override'], true) || !is_string($decision['sourceHash'] ?? null)) {
            $violations[] = ['code' => 'decision_invalid', 'path' => $path, 'message' => "Decision {$path} must declare mode and sourceHash."];
            continue;
        }
        if ($decision['mode'] === 'override' && !array_key_exists('value', $decision)) {
            $violations[] = ['code' => 'decision_override_missing', 'path' => $path, 'message' => "Override decision {$path} requires value."];
        }
        if (!hash_equals($leaves[$path]['sourceHash'], $decision['sourceHash'])) {
            $violations[] = ['code' => 'decision_stale', 'path' => $path, 'message' => "Decision {$path} no longer matches its WordPress/ACF source."];
        }
    }
    if ($complete) {
        foreach ($leaves as $path => $_leaf) {
            if (!array_key_exists($path, $decisions)) {
                $violations[] = ['code' => 'decision_unresolved', 'path' => $path, 'message' => "Effective content leaf {$path} needs an inherit or override decision."];
            }
        }
    }
    return $violations;
}

function zeroy_runtime_locale_envelope_violations(array $document, array $definition, int $object_id, bool $complete): array
{
    if (($document['contract'] ?? null) !== ZEROY_LOCALE_VERSION_CONTRACT) {
        return [['code' => 'locale_contract_invalid', 'message' => 'Canonical LocaleVersion must use ' . ZEROY_LOCALE_VERSION_CONTRACT . '.']];
    }
    $nodes = $document['nodes'] ?? null;
    $decisions = $document['decisions'] ?? null;
    if (
        !is_array($nodes) || array_is_list($nodes) && count($nodes) > 0 ||
        !is_array($decisions) || array_is_list($decisions) && count($decisions) > 0
    ) {
        return [['code' => 'locale_envelope_invalid', 'message' => 'LocaleVersion requires keyed nodes and decisions objects.']];
    }
    $tree = zeroy_runtime_effective_content_tree($object_id);
    if (is_wp_error($tree)) {
        return [['code' => $tree->get_error_code(), 'message' => $tree->get_error_message()]];
    }
    return [
        ...zeroy_runtime_document_violations($nodes, $definition, $complete),
        ...zeroy_runtime_decision_violations($decisions, $tree, $complete),
    ];
}

function zeroy_runtime_validate_version_document(int $object_id, array $document, array $definition, bool $complete): array|WP_Error
{
    if ($object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        if (($document['contract'] ?? null) !== ZEROY_THEME_COPY_VERSION_CONTRACT || !is_array($document['nodes'] ?? null) || array_is_list($document['nodes']) && count($document['nodes']) > 0) {
            return zeroy_runtime_error('zeroy_theme_copy_envelope_invalid', 'ThemeCopy version requires contract ' . ZEROY_THEME_COPY_VERSION_CONTRACT . ' and a keyed nodes object.', 400);
        }
        $violations = zeroy_runtime_document_violations($document['nodes'], $definition, $complete);
    } else {
        $violations = zeroy_runtime_locale_envelope_violations($document, $definition, $object_id, $complete);
    }
    if (count($violations) === 0) {
        return $document;
    }
    $blocking = array_filter($violations, static fn(array $violation): bool => in_array($violation['code'], ['document_node_required', 'decision_unresolved', 'decision_stale'], true));
    return zeroy_runtime_error(
        count($blocking) > 0 ? 'zeroy_locale_incomplete' : 'zeroy_locale_invalid',
        $violations[0]['message'],
        count($blocking) > 0 ? 409 : 400,
        ['violations' => $violations]
    );
}

function zeroy_runtime_version_contract_hash(int $object_id, array $definition): string|WP_Error
{
    if ($object_id === ZEROY_RUNTIME_THEME_COPY_OBJECT_ID) {
        return zeroy_runtime_hash(['contract' => ZEROY_THEME_COPY_VERSION_CONTRACT, 'schema' => $definition]);
    }
    $tree = zeroy_runtime_effective_content_tree($object_id);
    if (is_wp_error($tree)) {
        return $tree;
    }
    return zeroy_runtime_hash([
        'contract' => ZEROY_LOCALE_VERSION_CONTRACT,
        'schema' => $definition,
        'sourceHash' => $tree['sourceHash'],
    ]);
}

function zeroy_runtime_set_nested(array &$root, array $parts, mixed $value): bool
{
    $cursor =& $root;
    foreach ($parts as $index => $part) {
        $last = $index === count($parts) - 1;
        if ($last) {
            $cursor[$part] = $value;
            return true;
        }
        if (!is_array($cursor) || !array_key_exists($part, $cursor) || !is_array($cursor[$part])) {
            return false;
        }
        $cursor =& $cursor[$part];
    }
    return false;
}

function zeroy_runtime_resolve_locale_envelope(int $object_id, array $document, array $definition, bool $complete = true): array|WP_Error
{
    $validated = zeroy_runtime_validate_version_document($object_id, $document, $definition, $complete);
    if (is_wp_error($validated)) {
        return $validated;
    }
    $tree = zeroy_runtime_effective_content_tree($object_id);
    if (is_wp_error($tree)) {
        return $tree;
    }
    $resolved = ['post' => $tree['post'], 'acf' => $tree['acf']];
    foreach ($document['decisions'] as $path => $decision) {
        if (($decision['mode'] ?? null) !== 'override') {
            continue;
        }
        $parts = zeroy_runtime_pointer_parts($path);
        if (is_wp_error($parts) || !zeroy_runtime_set_nested($resolved, $parts, $decision['value'])) {
            return zeroy_runtime_error('zeroy_content_path_invalid', "Could not resolve content decision {$path}.", 409);
        }
    }
    return ['nodes' => $document['nodes'], 'post' => $resolved['post'], 'acf' => $resolved['acf']];
}
