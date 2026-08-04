<?php

defined('ABSPATH') || exit;

const ZEROY_SITE_TREE_CONTRACT = 'zeroy/site-tree@2';

function zeroy_document_failure(string $code, string $path, string $content_path, string $evidence, string $repair, array $extra = []): array
{
    return $extra + [
        'code' => $code,
        'documentPath' => $path,
        'contentPath' => $content_path,
        'evidence' => $evidence,
        'repair' => $repair,
    ];
}

function zeroy_document_exact_object(mixed $value, array $allowed, string $path, string $content_path, array &$failures): ?array
{
    if (!zeroy_runtime_is_keyed_map($value)) {
        $failures[] = zeroy_document_failure('document_object_required', $path, $content_path, 'The value is not a JSON object.', 'Replace it with an object matching the linked concrete contract.');
        return null;
    }
    foreach (array_keys($value) as $key) {
        if (!in_array($key, $allowed, true)) {
            $failures[] = zeroy_document_failure('document_property_unknown', $path, $content_path === '' ? $key : $content_path . '.' . $key, "Property {$key} is not writable here.", 'Remove the property or move the fact to the path that owns it.');
        }
    }
    return $value;
}

function zeroy_document_ref_valid(string $value): bool
{
    return preg_match('/\A[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?\z/', $value) === 1;
}

function zeroy_document_locale_valid(string $value): bool
{
    return preg_match('/\A[a-z]{2,3}(?:-[A-Z]{2})?\z/', $value) === 1;
}

function zeroy_document_decode_site(array $files, array &$failures): ?array
{
    $path = 'site.json';
    $file = $files[$path] ?? null;
    $decoded = is_array($file) ? json_decode((string) ($file['bytes'] ?? ''), true) : null;
    $site = zeroy_document_exact_object($decoded, ['workspaceFormat', 'defaultLocale', 'locales', 'collections'], $path, '', $failures);
    if ($site === null) return null;
    if (($site['workspaceFormat'] ?? null) !== ZEROY_SITE_TREE_CONTRACT) {
        $failures[] = zeroy_document_failure('workspace_format_invalid', $path, 'workspaceFormat', 'site.json does not declare zeroy/site-tree@2.', 'Set workspaceFormat to zeroy/site-tree@2.');
    }
    $default = is_string($site['defaultLocale'] ?? null) ? $site['defaultLocale'] : '';
    $locales = $site['locales'] ?? null;
    $normalized_locales = is_array($locales) ? array_map(static fn(mixed $locale): string => is_string($locale) ? strtolower($locale) : '', $locales) : [];
    if (!zeroy_document_locale_valid($default) || !is_array($locales) || !array_is_list($locales) || $locales === [] || count(array_unique($normalized_locales)) !== count($locales) || !in_array($default, $locales, true)) {
        $failures[] = zeroy_document_failure('workspace_locales_invalid', $path, 'locales', 'Locales must be a unique non-empty locale list containing defaultLocale.', 'Declare the default locale and every enabled locale once.');
    } else {
        foreach ($locales as $index => $locale) if (!is_string($locale) || !zeroy_document_locale_valid($locale)) {
            $failures[] = zeroy_document_failure('workspace_locale_invalid', $path, "locales.{$index}", 'Locale is not a supported BCP-47 language tag.', 'Use a language tag such as en, ja, it, or zh-CN.');
        }
    }
    $collections = $site['collections'] ?? null;
    if (!zeroy_runtime_is_keyed_map($collections)) {
        $failures[] = zeroy_document_failure('workspace_collections_invalid', $path, 'collections', 'collections must be a keyed object.', 'Map stable collection ids to postType and schemaId.');
        $collections = [];
    }
    $normalized = [];
    foreach ($collections as $id => $input) {
        if (!is_string($id) || !zeroy_document_ref_valid($id)) {
            $failures[] = zeroy_document_failure('workspace_collection_id_invalid', $path, 'collections', 'Collection id is not path-safe.', 'Use a stable lowercase path-safe collection id.');
            continue;
        }
        $collection = zeroy_document_exact_object($input, ['subjectKind', 'postType', 'schemaId'], $path, "collections.{$id}", $failures);
        if ($collection === null || ($collection['subjectKind'] ?? null) !== 'post' || !is_string($collection['postType'] ?? null) || $collection['postType'] === '' || !is_string($collection['schemaId'] ?? null) || $collection['schemaId'] === '') {
            $failures[] = zeroy_document_failure('workspace_collection_invalid', $path, "collections.{$id}", 'A post collection requires subjectKind=post, postType, and schemaId.', 'Complete the collection mapping using the current ThemeSchema.');
            continue;
        }
        $normalized[$id] = $collection;
    }
    ksort($normalized, SORT_STRING);
    return ['workspaceFormat' => ZEROY_SITE_TREE_CONTRACT, 'defaultLocale' => $default, 'locales' => is_array($locales) ? $locales : [], 'collections' => $normalized];
}

function zeroy_document_path(string $path, array $site): ?array
{
    if ($path === 'content/site-copy.json') return ['kind' => 'site-copy', 'locale' => null];
    if (preg_match('#\Alocales/([^/]+)/site-copy\.json\z#', $path, $match) === 1) return ['kind' => 'site-copy', 'locale' => $match[1]];
    if (preg_match('#\Acontent/posts/([^/]+)/([^/]+)\.json\z#', $path, $match) === 1) return ['kind' => 'post', 'locale' => null, 'collection' => $match[1], 'ref' => $match[2]];
    if (preg_match('#\Alocales/([^/]+)/posts/([^/]+)/([^/]+)\.json\z#', $path, $match) === 1) return ['kind' => 'post', 'locale' => $match[1], 'collection' => $match[2], 'ref' => $match[3]];
    if (preg_match('#\Acontent/terms/([^/]+)/([^/]+)\.json\z#', $path, $match) === 1) return ['kind' => 'term', 'locale' => null, 'taxonomy' => $match[1], 'ref' => $match[2]];
    if (preg_match('#\Alocales/([^/]+)/terms/([^/]+)/([^/]+)\.json\z#', $path, $match) === 1) return ['kind' => 'term', 'locale' => $match[1], 'taxonomy' => $match[2], 'ref' => $match[3]];
    return null;
}

function zeroy_document_decode_all(array $files, array $site, array &$failures): array
{
    $documents = [];
    $forbidden_roots = ['contract', 'ref', 'locale', 'postType', 'schemaId'];
    foreach ($files as $path => $file) {
        if ($path === 'site.json' || str_starts_with($path, 'artifacts/') || str_starts_with($path, 'media/')) continue;
        if (str_starts_with($path, 'translations/')) {
            $failures[] = zeroy_document_failure('legacy_translation_path_forbidden', $path, '', 'translations/ is not part of SiteTree v2.', 'Move localized business content under locales/<locale>/.');
            continue;
        }
        $identity = zeroy_document_path($path, $site);
        if ($identity === null) {
            $failures[] = zeroy_document_failure('document_path_invalid', $path, '', 'The path does not identify a SiteTree v2 document.', 'Use a concrete content/ or locales/<locale>/ document path.');
            continue;
        }
        if (isset($identity['collection']) && !isset($site['collections'][$identity['collection']])) {
            $failures[] = zeroy_document_failure('document_collection_unknown', $path, '', 'The path names a collection absent from site.json.', 'Declare the collection in site.json or move the document.');
        }
        if (isset($identity['ref']) && !zeroy_document_ref_valid((string) $identity['ref'])) {
            $failures[] = zeroy_document_failure('document_ref_invalid', $path, '', 'The path contains an invalid stable ref.', 'Rename the file to a lowercase path-safe stable ref.');
        }
        $locale = $identity['locale'] ?? null;
        if (is_string($locale) && (!in_array($locale, $site['locales'], true) || $locale === $site['defaultLocale'])) {
            $failures[] = zeroy_document_failure('document_locale_invalid', $path, '', 'The locale path is disabled or is the canonical default locale.', 'Use content/ for the default locale and locales/<enabled-non-default-locale>/ otherwise.');
        }
        $decoded = json_decode((string) ($file['bytes'] ?? ''), true);
        if (!zeroy_runtime_is_keyed_map($decoded)) {
            $failures[] = zeroy_document_failure('document_json_invalid', $path, '', 'The file is not a JSON object.', 'Start from the linked minimal template.');
            continue;
        }
        foreach ($forbidden_roots as $field) if (array_key_exists($field, $decoded)) {
            $failures[] = zeroy_document_failure('document_identity_duplicated', $path, $field, "{$field} duplicates identity already owned by the file path or site.json.", "Remove {$field} from the document body.");
        }
        $allowed = match ($identity['kind']) {
            'post' => is_string($locale) ? ['post', 'acf', 'templateContent', 'review'] : ['route', 'post', 'acf', 'templateContent', 'terms'],
            'term' => is_string($locale) ? ['name', 'description', 'review'] : ['slug', 'name', 'description'],
            default => is_string($locale) ? [...array_keys($decoded), 'review'] : array_keys($decoded),
        };
        zeroy_document_exact_object($decoded, $allowed, $path, '', $failures);
        $documents[$path] = ['identity' => $identity, 'body' => $decoded];
    }
    ksort($documents, SORT_STRING);
    return $documents;
}

function zeroy_document_acf_fields(string $post_type): array
{
    if (!function_exists('acf_get_field_groups') || !function_exists('acf_get_fields')) return [];
    $fields = [];
    foreach (acf_get_field_groups(['post_type' => $post_type]) as $group) {
        foreach (is_array(acf_get_fields($group)) ? acf_get_fields($group) : [] as $field) {
            $key = (string) ($field['key'] ?? '');
            if ($key !== '' && !isset($fields[$key])) $fields[$key] = $field;
        }
    }
    ksort($fields, SORT_STRING);
    return $fields;
}

function zeroy_document_acf_children(array $field, ?array $row = null): array
{
    if (($field['type'] ?? null) !== 'flexible_content') return is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [];
    $layout = is_array($row) && is_string($row['acf_fc_layout'] ?? null) ? $row['acf_fc_layout'] : null;
    foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $definition) {
        if ($layout !== null && ($definition['name'] ?? null) !== $layout) continue;
        if (is_array($definition['sub_fields'] ?? null)) return $definition['sub_fields'];
    }
    return [];
}

function zeroy_document_validate_acf_registry(array $site, array $schema, array &$failures): void
{
    foreach ($site['collections'] as $collection_id => $collection) {
        $definition = $schema['schemas'][$collection['schemaId']] ?? null;
        if (!is_array($definition)) continue;
        $policy = zeroy_localization_compiled_policy($definition);
        $item_keys = is_wp_error($policy) ? [] : $policy['repeaterItemKeys'];
        foreach (zeroy_document_acf_fields($collection['postType']) as $field_key => $field) {
            $type = (string) ($field['type'] ?? '');
            if (!in_array($type, ['repeater', 'flexible_content'], true)) continue;
            $field_id = '/acf/' . zeroy_localization_pointer_segment((string) $field_key);
            $item_key = $item_keys[$field_id] ?? null;
            $children = [];
            if ($type === 'repeater') $children = array_column(zeroy_document_acf_children($field), 'key');
            else foreach (is_array($field['layouts'] ?? null) ? $field['layouts'] : [] as $layout) $children = [...$children, ...array_column(is_array($layout['sub_fields'] ?? null) ? $layout['sub_fields'] : [], 'key')];
            if (!is_string($item_key) || $item_key === '' || !in_array($item_key, $children, true)) {
                $failures[] = zeroy_document_failure(
                    'acf_item_key_missing',
                    'artifacts/theme/zeroy.schema.json',
                    "schemas.{$collection['schemaId']}.localization.repeaterItemKeys.{$field_id}",
                    "ACF {$type} {$field_key} has no valid stable item-key field.",
                    "Declare one child field key for {$field_id}; the generated collection contract will then own the normalized keyed-object shape.",
                    ['collection' => $collection_id],
                );
            }
        }
    }
}

function zeroy_document_acf_decode_field(array $field, mixed $value, array $item_keys, string $field_id, string $path, array &$failures): mixed
{
    $type = (string) ($field['type'] ?? '');
    $name = (string) ($field['name'] ?? '');
    if ($type === 'group') {
        if (!zeroy_runtime_is_keyed_map($value)) {
            $failures[] = zeroy_document_failure('acf_group_invalid', $path, $field_id, "ACF group {$field_id} must be an object.", 'Use stable child field keys from the concrete contract.');
            return [];
        }
        $result = [];
        foreach (zeroy_document_acf_children($field, $value) as $child) {
            $key = (string) ($child['key'] ?? '');
            if ($key !== '' && array_key_exists($key, $value)) $result[$key] = zeroy_document_acf_decode_field($child, $value[$key], $item_keys, $field_id . '/' . zeroy_localization_pointer_segment($key), $path, $failures);
        }
        foreach (array_keys($value) as $key) if (!in_array($key, array_column(zeroy_document_acf_children($field, $value), 'key'), true)) $failures[] = zeroy_document_failure('acf_field_unknown', $path, "acf.{$key}", 'Unknown ACF child field key.', 'Use only keys in the concrete contract.');
        return $result;
    }
    if (in_array($type, ['repeater', 'flexible_content'], true) && isset($item_keys[$field_id])) {
        if (!zeroy_runtime_is_keyed_map($value)) {
            $failures[] = zeroy_document_failure('acf_collection_invalid', $path, $field_id, "ACF {$type} {$field_id} must be keyed by stable item identity.", 'Use the item-key object shape in the concrete template.');
            return [];
        }
        $rows = [];
        foreach ($value as $item_key => $row) {
            if (!is_string($item_key) || trim($item_key) === '' || !zeroy_runtime_is_keyed_map($row)) {
                $failures[] = zeroy_document_failure('acf_collection_item_invalid', $path, $field_id, 'Every ACF collection item needs a non-empty object key and object value.', 'Use one object per stable item key.');
                continue;
            }
            $decoded = [];
            $children = zeroy_document_acf_children($field, $row);
            if ($type === 'flexible_content' && $children === []) {
                $failures[] = zeroy_document_failure('acf_flexible_layout_invalid', $path, $field_id, 'Flexible-content row has an unknown or missing acf_fc_layout.', 'Use one layout name and its exact child fields from the concrete contract.');
                continue;
            }
            foreach ($children as $child) {
                $key = (string) ($child['key'] ?? '');
                if ($key !== '' && array_key_exists($key, $row)) $decoded[$key] = zeroy_document_acf_decode_field($child, $row[$key], $item_keys, $field_id . '/' . zeroy_localization_pointer_segment($item_key) . '/' . zeroy_localization_pointer_segment($key), $path, $failures);
                if ($key === $item_keys[$field_id] && !array_key_exists($key, $row)) $decoded[$key] = $item_key;
            }
            foreach (array_keys($row) as $key) if (!in_array($key, array_column($children, 'key'), true) && $key !== 'acf_fc_layout') $failures[] = zeroy_document_failure('acf_field_unknown', $path, "acf.{$field['key']}.{$item_key}.{$key}", 'Unknown ACF collection child field key.', 'Use only keys in the concrete contract.');
            if ($type === 'flexible_content' && is_string($row['acf_fc_layout'] ?? null)) $decoded['acf_fc_layout'] = $row['acf_fc_layout'];
            $rows[$item_key] = $decoded;
        }
        return $rows;
    }
    $reference_kind = match ($type) {
        'image', 'file', 'gallery' => 'media',
        'post_object', 'relationship' => 'post',
        'taxonomy' => 'term',
        default => null,
    };
    if ($reference_kind !== null) {
        $multiple = in_array($type, ['gallery', 'relationship'], true) || !empty($field['multiple']) || ($type === 'taxonomy' && !empty($field['add_term']));
        $items = $multiple ? $value : [$value];
        if (!is_array($items) || ($multiple && !array_is_list($items))) {
            $failures[] = zeroy_document_failure('acf_reference_shape_invalid', $path, $field_id, "ACF {$type} must use typed stable references.", 'Use the exact reference object shape from the concrete contract.');
            return $multiple ? [] : null;
        }
        $decoded = [];
        foreach ($items as $index => $reference) {
            if ($reference === null && !$multiple) return null;
            $valid = zeroy_runtime_is_keyed_map($reference)
                && ($reference['kind'] ?? null) === $reference_kind
                && is_string($reference['ref'] ?? null)
                && zeroy_document_ref_valid(str_replace('/', '-', (string) $reference['ref']))
                && ($reference_kind !== 'term' || is_string($reference['taxonomy'] ?? null));
            if (!$valid) {
                $failures[] = zeroy_document_failure('acf_reference_invalid', $path, $field_id . ($multiple ? '.' . $index : ''), "ACF {$type} reference is not a typed stable {$reference_kind} ref.", 'Use the exact reference object shape from the concrete contract; WordPress IDs are not authored facts.');
                continue;
            }
            $decoded[] = $reference;
        }
        return $multiple ? $decoded : ($decoded[0] ?? null);
    }
    $supported = ['text', 'textarea', 'wysiwyg', 'number', 'range', 'email', 'url', 'password', 'true_false', 'select', 'checkbox', 'radio', 'button_group', 'date_picker', 'date_time_picker', 'time_picker', 'color_picker', 'oembed', 'link', 'google_map', 'group', 'repeater', 'flexible_content'];
    if (!in_array($type, $supported, true)) $failures[] = zeroy_document_failure('acf_type_unsupported', $path, $field_id, "ACF type {$type} has no Document Algebra codec.", 'Add a codec to the Connector before authoring this field.');
    return $value;
}

function zeroy_document_acf_encode_field(array $field, mixed $value, array $item_keys, string $field_id, callable $reference, string $path, array &$failures): mixed
{
    $type = (string) ($field['type'] ?? '');
    if ($type === 'group') {
        if (!is_array($value)) return [];
        $encoded = [];
        foreach (zeroy_document_acf_children($field, $value) as $child) {
            $key = (string) ($child['key'] ?? '');
            $name = (string) ($child['name'] ?? '');
            if ($key !== '' && $name !== '' && array_key_exists($name, $value)) $encoded[$key] = zeroy_document_acf_encode_field($child, $value[$name], $item_keys, $field_id . '/' . zeroy_localization_pointer_segment($key), $reference, $path, $failures);
        }
        return $encoded;
    }
    if (in_array($type, ['repeater', 'flexible_content'], true)) {
        $item_key_field = $item_keys[$field_id] ?? null;
        if (!is_string($item_key_field) || !is_array($value) || !array_is_list($value)) {
            $failures[] = zeroy_document_failure('acf_collection_invalid', $path, $field_id, "Runtime ACF {$type} cannot be normalized without a stable item-key field.", 'Declare repeaterItemKeys and repair the canonical ACF value.');
            return [];
        }
        $rows = [];
        foreach ($value as $index => $row) {
            if (!is_array($row)) continue;
            $children = zeroy_document_acf_children($field, $row);
            $item_definition = null;
            foreach ($children as $child) if (($child['key'] ?? null) === $item_key_field) $item_definition = $child;
            $item_name = is_array($item_definition) ? (string) ($item_definition['name'] ?? '') : '';
            $item_key = $item_name !== '' && is_scalar($row[$item_name] ?? null) ? trim((string) $row[$item_name]) : '';
            if ($item_key === '' || isset($rows[$item_key])) {
                $failures[] = zeroy_document_failure('acf_collection_item_key_invalid', $path, $field_id . '.' . $index, 'Runtime ACF collection item key is empty or duplicated.', 'Give every row one unique stable item-key value.');
                continue;
            }
            $encoded = [];
            if ($type === 'flexible_content' && is_string($row['acf_fc_layout'] ?? null)) $encoded['acf_fc_layout'] = $row['acf_fc_layout'];
            foreach ($children as $child) {
                $key = (string) ($child['key'] ?? '');
                $name = (string) ($child['name'] ?? '');
                if ($key !== '' && $name !== '' && array_key_exists($name, $row)) $encoded[$key] = zeroy_document_acf_encode_field($child, $row[$name], $item_keys, $field_id . '/' . zeroy_localization_pointer_segment($item_key) . '/' . zeroy_localization_pointer_segment($key), $reference, $path, $failures);
            }
            $rows[$item_key] = $encoded;
        }
        return $rows;
    }
    $kind = match ($type) {
        'image', 'file', 'gallery' => 'media',
        'post_object', 'relationship' => 'post',
        'taxonomy' => 'term',
        default => null,
    };
    if ($kind === null) return $value;
    $multiple = in_array($type, ['gallery', 'relationship'], true) || !empty($field['multiple']) || ($type === 'taxonomy' && !empty($field['add_term']));
    $values = $multiple ? $value : [$value];
    if (!is_array($values) || ($multiple && !array_is_list($values))) return $multiple ? [] : null;
    $encoded = [];
    foreach ($values as $item) {
        if ($item === null && !$multiple) return null;
        $resolved = $reference($kind, $item, $field);
        if (is_wp_error($resolved)) {
            $failures[] = zeroy_document_failure($resolved->get_error_code(), $path, $field_id, $resolved->get_error_message(), 'Bind the WordPress object to one authored stable ref before checkout projection.');
            continue;
        }
        $encoded[] = $resolved;
    }
    return $multiple ? $encoded : ($encoded[0] ?? null);
}

function zeroy_document_acf_decode(array $body, string $post_type, array $definition, string $path, array &$failures): array
{
    $input = $body['acf'] ?? [];
    if (!zeroy_runtime_is_keyed_map($input)) {
        $failures[] = zeroy_document_failure('acf_object_invalid', $path, 'acf', 'acf must be an object keyed by stable ACF field key.', 'Use the collection concrete contract.');
        return [];
    }
    $policy = zeroy_localization_compiled_policy($definition);
    $item_keys = is_wp_error($policy) ? [] : $policy['repeaterItemKeys'];
    $fields = zeroy_document_acf_fields($post_type);
    $view = [];
    foreach ($input as $key => $value) {
        $field = $fields[$key] ?? null;
        if (!is_array($field)) {
            $failures[] = zeroy_document_failure('acf_field_unknown', $path, "acf.{$key}", 'The ACF field key is not applicable to this post type.', 'Use a stable field key from the concrete collection contract.');
            continue;
        }
        $view[(string) $key] = zeroy_document_acf_decode_field($field, $value, $item_keys, '/acf/' . zeroy_localization_pointer_segment((string) $key), $path, $failures);
    }
    return $view;
}

function zeroy_document_internal_field_map(array $localizable): array
{
    $map = [];
    foreach (is_array($localizable['fields'] ?? null) ? $localizable['fields'] : [] as $field) {
        $id = (string) ($field['fieldId'] ?? '');
        if ($id === '') continue;
        $parts = zeroy_localization_pointer_parts($id);
        if (is_wp_error($parts) || $parts === []) continue;
        $root = array_shift($parts);
        $path = match ($root) {
            'template-content' => 'templateContent',
            'site-copy', 'term' => '',
            default => $root,
        };
        foreach ($parts as $part) $path = $path === '' ? $part : $path . '.' . $part;
        $map[$path] = $field;
    }
    return $map;
}

function zeroy_document_flatten(mixed $value, string $prefix = ''): array
{
    if (zeroy_runtime_is_keyed_map($value) && in_array($value['kind'] ?? null, ['post', 'term', 'media'], true) && is_string($value['ref'] ?? null)) return [$prefix => $value];
    if (!is_array($value) || array_is_list($value)) return [$prefix => $value];
    $flat = [];
    foreach ($value as $key => $child) {
        $path = $prefix === '' ? (string) $key : $prefix . '.' . $key;
        $flat += zeroy_document_flatten($child, $path);
    }
    return $flat;
}

/**
 * Flatten a locale document using the compiled localizable field set as the
 * owner of leaf identity. JSON objects and arrays both decode to PHP arrays;
 * shape inference therefore cannot decide whether [] is an empty container or
 * an authored leaf value. The field algebra can: exact field paths are leaves,
 * their prefixes are containers, and every other path is unknown.
 */
function zeroy_document_container_paths(array $localizable, array $fields): array
{
    $containers = ['' => true];
    foreach ($fields as $path => $_field) {
        $parts = explode('.', (string) $path);
        array_pop($parts);
        while ($parts !== []) {
            $containers[implode('.', $parts)] = true;
            array_pop($parts);
        }
    }
    if (($localizable['subject']['kind'] ?? null) === 'post') {
        foreach (['post', 'acf', 'templateContent'] as $path) $containers[$path] = true;
    }
    return $containers;
}

function zeroy_document_flatten_for_fields(mixed $value, array $field_paths, array $container_paths, string $prefix = ''): array
{
    if ($prefix !== '' && isset($field_paths[$prefix])) return [$prefix => $value];
    if (isset($container_paths[$prefix]) && is_array($value) && $value === []) return [];
    if (!is_array($value) || array_is_list($value)) return [$prefix => $value];

    $flat = [];
    foreach ($value as $key => $child) {
        $path = $prefix === '' ? (string) $key : $prefix . '.' . $key;
        $flat += zeroy_document_flatten_for_fields($child, $field_paths, $container_paths, $path);
    }
    return $flat;
}

function zeroy_document_locale_values(array $body, array $localizable, string $path, array &$failures): array
{
    $copy = array_diff_key($body, ['review' => true]);
    $fields = zeroy_document_internal_field_map($localizable);
    $flat = zeroy_document_flatten_for_fields($copy, $fields, zeroy_document_container_paths($localizable, $fields));
    $values = [];
    foreach ($flat as $content_path => $value) {
        $field = $fields[$content_path] ?? null;
        if (!is_array($field)) {
            $failures[] = zeroy_document_failure('locale_path_not_writable', $path, $content_path, 'This natural content path is unknown, shared, derived, or not writable in this locale.', 'Remove it or use a translated/overridable path from the concrete locale contract.');
            continue;
        }
        $rule = $field['policy'] ?? null;
        if (!is_array($rule) || !in_array($rule['mode'] ?? null, ['translated', 'overridable'], true)) {
            $failures[] = zeroy_document_failure('locale_path_not_writable', $path, $content_path, 'Localization policy does not allow this field in a locale document.', 'Remove the shared or derived field.');
            continue;
        }
        $values[(string) $field['fieldId']] = $value;
    }
    return $values;
}

function zeroy_document_review_leaves(mixed $value, string $prefix = ''): array
{
    if (zeroy_runtime_is_keyed_map($value) && isset($value['decision'])) return [$prefix => $value];
    if (!zeroy_runtime_is_keyed_map($value)) return [];
    $leaves = [];
    foreach ($value as $key => $child) $leaves += zeroy_document_review_leaves($child, $prefix === '' ? (string) $key : $prefix . '.' . $key);
    return $leaves;
}

function zeroy_document_validate_reviews(array $body, array $localizable, array $current, string $path, array $changed_review_paths, array &$failures): void
{
    $reviews = zeroy_document_review_leaves($body['review'] ?? []);
    if ($reviews === []) return;
    $fields = zeroy_document_internal_field_map($localizable);
    $published = is_array($current['publishedOverlay']['values'] ?? null) ? $current['publishedOverlay']['values'] : [];
    foreach ($reviews as $content_path => $review) {
        $field = $fields[$content_path] ?? null;
        $stored = is_array($field) ? ($published[$field['fieldId']] ?? null) : null;
        $stale = is_array($field) && is_array($stored) && is_string($stored['sourceHash'] ?? null) && !hash_equals((string) $stored['sourceHash'], (string) $field['sourceHash']);
        if (($review['decision'] ?? null) !== 'confirmed-current' || !is_string($review['reviewedAt'] ?? null) || !is_string($review['note'] ?? null)) {
            $failures[] = zeroy_document_failure('locale_review_invalid', $path, 'review.' . $content_path, 'Review requires decision=confirmed-current, reviewedAt, and note.', 'Use the concrete locale contract review shape.');
        } elseif (!isset($changed_review_paths[$content_path])) {
            $failures[] = zeroy_document_failure('locale_review_unchanged', $path, 'review.' . $content_path, 'Historical unchanged review cannot confirm a new source change.', 'Change the locale file in this commit after reviewing the current canonical source.');
        } elseif (!$stale) {
            $failures[] = zeroy_document_failure('locale_review_not_stale', $path, 'review.' . $content_path, 'Review path is not currently stale.', 'Remove the review decision or point it at a stale locale leaf listed in repair frontier.');
        }
    }
}

function zeroy_document_changed_leaf_paths(array $current, array $parent): array
{
    $current_flat = zeroy_document_flatten($current);
    $parent_flat = zeroy_document_flatten($parent);
    $changed = [];
    foreach (array_unique([...array_keys($current_flat), ...array_keys($parent_flat)]) as $path) {
        if (!array_key_exists($path, $current_flat) || !array_key_exists($path, $parent_flat) || $current_flat[$path] !== $parent_flat[$path]) $changed[$path] = true;
    }
    return $changed;
}

function zeroy_document_changed_entries(array $current, array $parent): array
{
    $changed = [];
    foreach (array_unique([...array_keys($current), ...array_keys($parent)]) as $path) {
        if (!array_key_exists($path, $current) || !array_key_exists($path, $parent) || $current[$path] !== $parent[$path]) $changed[$path] = true;
    }
    return $changed;
}

function zeroy_document_change_map(array $files, array $parent_files): array
{
    $changes = [];
    foreach (array_unique([...array_keys($files), ...array_keys($parent_files)]) as $path) {
        if (!str_starts_with($path, 'locales/') || !str_ends_with($path, '.json')) continue;
        $current = is_array($files[$path] ?? null) ? json_decode((string) ($files[$path]['bytes'] ?? ''), true) : [];
        $parent = is_array($parent_files[$path] ?? null) ? json_decode((string) ($parent_files[$path]['bytes'] ?? ''), true) : [];
        $current = zeroy_runtime_is_keyed_map($current) ? $current : [];
        $parent = zeroy_runtime_is_keyed_map($parent) ? $parent : [];
        $current_content = array_diff_key($current, ['review' => true]);
        $parent_content = array_diff_key($parent, ['review' => true]);
        $changes[$path] = [
            'content' => zeroy_document_changed_leaf_paths($current_content, $parent_content),
            'review' => zeroy_document_changed_entries(
                zeroy_document_review_leaves($current['review'] ?? []),
                zeroy_document_review_leaves($parent['review'] ?? []),
            ),
            'parentContent' => zeroy_document_flatten($parent_content),
        ];
    }
    return $changes;
}

function zeroy_document_enabled_locales(array $site, array $current_config): array
{
    $current_by_locale = [];
    foreach (is_array($current_config['enabledLocales'] ?? null) ? $current_config['enabledLocales'] : [] as $candidate) {
        if (!is_array($candidate) || !is_string($candidate['locale'] ?? null)) continue;
        $current_by_locale[$candidate['locale']] = $candidate;
    }
    $enabled = [];
    $used_prefixes = [];
    foreach ($site['locales'] as $locale) {
        $current = is_array($current_by_locale[$locale] ?? null) ? $current_by_locale[$locale] : [];
        $label = trim((string) ($current['label'] ?? ''));
        if ($label === '' || strlen($label) > 80) $label = $locale;
        $prefix = $locale === $site['defaultLocale']
            ? ''
            : trim(wp_normalize_path((string) ($current['urlPrefix'] ?? '')), '/');
        if ($locale !== $site['defaultLocale'] && (
            $prefix === ''
            || preg_match('/\A[a-z0-9][a-z0-9\-]*\z/i', $prefix) !== 1
            || isset($used_prefixes[strtolower($prefix)])
        )) $prefix = strtolower($locale);
        $used_prefixes[strtolower($prefix)] = true;
        $enabled[] = ['locale' => $locale, 'label' => $label, 'urlPrefix' => strtolower($prefix)];
    }
    return $enabled;
}

function zeroy_document_media_operations(array $files, array &$failures): array
{
    $operations = [];
    foreach ($files as $path => $file) {
        if (!str_starts_with($path, 'media/')) continue;
        $ref = substr($path, strlen('media/'));
        if ($ref === '' || preg_match('#\A[a-z0-9](?:[a-z0-9._/-]{0,190}[a-z0-9])?\z#', $ref) !== 1 || !is_string($file['bytes'] ?? null)) {
            $failures[] = zeroy_document_failure('media_path_invalid', $path, '', 'Authored media path cannot be used as a stable media ref.', 'Use a lowercase path-safe file path under media/.');
            continue;
        }
        $hash = zeroy_checkout_blob_hash($file['bytes']);
        $unmanaged = zeroy_adoption_find_unmanaged_media($ref);
        if (is_wp_error($unmanaged)) {
            $failures[] = zeroy_document_failure($unmanaged->get_error_code(), $path, '', $unmanaged->get_error_message(), 'Give every unmanaged attachment one unique path-safe filename.');
            continue;
        }
        $operations[] = $unmanaged instanceof WP_Post
            ? ['kind' => 'adoptMedia', 'payload' => ['attachmentId' => (int) $unmanaged->ID, 'ref' => $ref, 'expectedSourceHash' => $hash]]
            : ['kind' => 'upsertMedia', 'payload' => ['ref' => $ref, 'hash' => $hash]];
    }
    return $operations;
}

function zeroy_document_post_parts(array $document, array $collection, array $schema, string $path, array &$failures): array
{
    $definition = $schema['schemas'][$collection['schemaId']] ?? null;
    if (!is_array($definition) || !in_array($collection['postType'], $definition['canonicalPostTypes'] ?? [], true)) {
        $failures[] = zeroy_document_failure('collection_schema_invalid', 'site.json', 'collections', 'The collection postType/schemaId mapping is not admitted by ThemeSchema.', 'Use one schema and post type pair declared by the compiled ThemeSchema.');
        return ['postTitle' => '', 'postContent' => '', 'postExcerpt' => '', 'acf' => [], 'templateContent' => []];
    }
    $post = zeroy_document_exact_object($document['post'] ?? [], ['title', 'content', 'excerpt'], $path, 'post', $failures) ?? [];
    $template = $document['templateContent'] ?? [];
    if (!zeroy_runtime_is_keyed_map($template)) {
        $failures[] = zeroy_document_failure('template_content_invalid', $path, 'templateContent', 'templateContent must be a keyed object.', 'Use keys declared by this collection concrete contract.');
        $template = [];
    }
    foreach ($template as $key => $value) if (!isset($definition['templateContent'][$key]) || !is_string($value)) {
        $failures[] = zeroy_document_failure('template_content_field_invalid', $path, "templateContent.{$key}", 'Template content key is unknown or its value is not text.', 'Use only text keys from the collection concrete contract.');
    }
    $route = $document['route'] ?? null;
    if (!is_string($route) || is_wp_error(zeroy_runtime_normalize_route($route))) {
        $failures[] = zeroy_document_failure('canonical_route_invalid', $path, 'route', 'Canonical route is missing or invalid.', 'Declare one explicit absolute route such as /machines/pellet-mill/.');
    }
    return [
        'postTitle' => is_string($post['title'] ?? null) ? $post['title'] : '',
        'postContent' => is_string($post['content'] ?? null) ? $post['content'] : '',
        'postExcerpt' => is_string($post['excerpt'] ?? null) ? $post['excerpt'] : '',
        'acf' => zeroy_document_acf_decode($document, $collection['postType'], $definition, $path, $failures),
        'templateContent' => $template,
    ];
}

function zeroy_document_find_base_entity(array $snapshot, array $collection, string $ref, string $route): ?array
{
    foreach ($snapshot['entities'] ?? [] as $identity => $entity) {
        if (!is_array($entity)) continue;
        if (($entity['authoredRef'] ?? null) === $ref) return ['identity' => $identity, 'entity' => $entity];
        if (($entity['postType'] ?? null) === $collection['postType'] && ($entity['schemaId'] ?? null) === $collection['schemaId'] && ($entity['route'] ?? null) === $route) return ['identity' => $identity, 'entity' => $entity];
    }
    return null;
}

function zeroy_document_term_assignments(array $body, array $documents, string $path, array &$failures): array
{
    $input = $body['terms'] ?? [];
    if (!zeroy_runtime_is_keyed_map($input)) {
        $failures[] = zeroy_document_failure('term_assignments_invalid', $path, 'terms', 'terms must map taxonomy names to typed stable term references.', 'Use the exact terms shape from the concrete contract.');
        return [];
    }
    $catalog = [];
    foreach ($documents as $entry) {
        $identity = $entry['identity'] ?? null;
        if (!is_array($identity) || ($identity['kind'] ?? null) !== 'term' || ($identity['locale'] ?? null) !== null) continue;
        $slug = $entry['body']['slug'] ?? null;
        if (is_string($slug) && $slug !== '') $catalog[(string) $identity['taxonomy'] . ':' . (string) $identity['ref']] = $slug;
    }
    $result = [];
    foreach ($input as $taxonomy => $references) {
        if (!is_string($taxonomy) || !is_array($references) || !array_is_list($references)) {
            $failures[] = zeroy_document_failure('term_assignments_invalid', $path, 'terms.' . (string) $taxonomy, 'Taxonomy assignment must be a list of typed stable term references.', 'Use references from content/terms/<taxonomy>/.');
            continue;
        }
        $slugs = [];
        foreach ($references as $index => $reference) {
            $ref = is_array($reference) && ($reference['kind'] ?? null) === 'term' && is_string($reference['ref'] ?? null) ? $reference['ref'] : null;
            $key = $ref === null ? '' : $taxonomy . ':' . $ref;
            if ($ref === null || !isset($catalog[$key])) {
                $failures[] = zeroy_document_failure('term_assignment_ref_missing', $path, "terms.{$taxonomy}.{$index}", 'Term assignment does not resolve to an authored canonical term.', 'Create content/terms/' . $taxonomy . '/<ref>.json and reference that stable ref.');
                continue;
            }
            $slugs[] = $catalog[$key];
        }
        $result[$taxonomy] = $slugs;
    }
    ksort($result, SORT_STRING);
    return $result;
}

function zeroy_document_post_localizable(array $parts, array $collection, array $schema, array $subject): array|WP_Error
{
    $definition = $schema['schemas'][$collection['schemaId']] ?? null;
    if (!is_array($definition)) return zeroy_runtime_error('zeroy_schema_not_found', 'Collection schema does not exist.', 409);
    $localizable = zeroy_localization_post_subject_from_view(
        $subject,
        $collection['schemaId'],
        $definition,
        $collection['postType'],
        ['post' => ['title' => $parts['postTitle'], 'content' => $parts['postContent'], 'excerpt' => $parts['postExcerpt']], 'acf' => $parts['acf'], 'templateContent' => $parts['templateContent']],
        1,
        ['post_type' => $collection['postType']],
    );
    if (is_wp_error($localizable)) return $localizable;
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    return is_wp_error($compiled) ? $compiled : [...$localizable, 'fields' => array_values($compiled['fields'])];
}

function zeroy_document_localizable_with_policy(array $localizable, array $definition): array|WP_Error
{
    $compiled = zeroy_localization_compile_subject_policy($localizable, $definition);
    return is_wp_error($compiled) ? $compiled : [...$localizable, 'fields' => array_values($compiled['fields'])];
}

function zeroy_document_locale_operations(array $documents, array $site, array $snapshot, array $subject, array $localizable, string $kind, array $identity, array $change_map, array &$failures): array
{
    $operations = [];
    $base = null;
    if ($kind === 'post') {
        foreach ($snapshot['entities'] ?? [] as $entity) if (is_array($entity) && ($entity['subject'] ?? null) === $subject) $base = $entity;
    } elseif ($kind === 'term') {
        foreach ($snapshot['terms'] ?? [] as $term) if (is_array($term) && ($term['subject'] ?? null) === $subject) $base = $term;
    } else $base = is_array($snapshot['siteCopy'] ?? null) ? $snapshot['siteCopy'] : null;
    $desired = [];
    foreach ($documents as $path => $entry) {
        $candidate = $entry['identity'];
        if (($candidate['kind'] ?? null) !== $kind || !is_string($candidate['locale'] ?? null)) continue;
        foreach ($identity as $key => $value) if (($candidate[$key] ?? null) !== $value) continue 2;
        $locale = $candidate['locale'];
        $desired[$locale] = true;
        $all_values = zeroy_document_locale_values($entry['body'], $localizable, $path, $failures);
        $current = is_array($base['locales'][$locale] ?? null) ? $base['locales'][$locale] : ['revision' => 0, 'publishedOverlay' => null];
        $changes = is_array($change_map[$path] ?? null) ? $change_map[$path] : ['content' => [], 'review' => [], 'parentContent' => []];
        zeroy_document_validate_reviews($entry['body'], $localizable, $current, $path, $changes['review'], $failures);
        $published_values = [];
        foreach (is_array($current['publishedOverlay']['values'] ?? null) ? $current['publishedOverlay']['values'] : [] as $field_id => $stored) if (is_array($stored) && array_key_exists('value', $stored)) $published_values[$field_id] = $stored['value'];
        $fields = zeroy_document_internal_field_map($localizable);
        $values = [];
        if (!is_array($current['publishedOverlay'] ?? null)) $values = $all_values;
        else {
            foreach ($changes['content'] as $content_path => $_changed) {
                $field = $fields[$content_path] ?? null;
                if (!is_array($field)) continue;
                $field_id = (string) $field['fieldId'];
                $values[$field_id] = array_key_exists($field_id, $all_values) ? $all_values[$field_id] : null;
            }
            foreach ($changes['review'] as $content_path => $_changed) {
                $current_reviews = zeroy_document_review_leaves($entry['body']['review'] ?? []);
                if (!isset($current_reviews[$content_path])) continue;
                $field = $fields[$content_path] ?? null;
                if (!is_array($field)) continue;
                $field_id = (string) $field['fieldId'];
                if (array_key_exists($field_id, $published_values)) $values[$field_id] = $published_values[$field_id];
            }
        }
        if ($values === []) continue;
        $revision = (int) ($current['revision'] ?? 0);
        $operations[] = ['kind' => 'writeTranslationDraft', 'payload' => ['subject' => $subject, 'locale' => $locale, 'values' => $values, 'expectedRevision' => $revision]];
        $operations[] = ['kind' => 'publishTranslation', 'payload' => ['subject' => $subject, 'locale' => $locale, 'expectedRevision' => $revision + 1]];
    }
    foreach (is_array($base['locales'] ?? null) ? $base['locales'] : [] as $locale => $current) {
        if ($locale === $site['defaultLocale'] || isset($desired[$locale]) || !is_array($current['publishedOverlay'] ?? null)) continue;
        $operations[] = ['kind' => 'unpublishTranslation', 'payload' => ['subject' => $subject, 'locale' => $locale, 'expectedRevision' => (int) ($current['revision'] ?? 0)]];
    }
    return $operations;
}

function zeroy_document_compile_operations(array $files, array $snapshot, array $schema, array $parent_files, array &$failures): array
{
    $site = zeroy_document_decode_site($files, $failures);
    if ($site === null) return [];
    $documents = zeroy_document_decode_all($files, $site, $failures);
    zeroy_document_validate_acf_registry($site, $schema, $failures);
    $change_map = zeroy_document_change_map($files, $parent_files);
    $site_copy_entry = $documents['content/site-copy.json'] ?? null;
    $site_copy = is_array($site_copy_entry) && zeroy_runtime_is_keyed_map($site_copy_entry['body']) ? $site_copy_entry['body'] : [];
    if ($site_copy_entry === null) $failures[] = zeroy_document_failure('site_copy_missing', 'content/site-copy.json', '', 'Canonical SiteCopy is missing.', 'Create it from the concrete SiteCopy template.');
    $current_config = is_array($snapshot['siteConfig'] ?? null) ? $snapshot['siteConfig'] : [];
    $config = [
        'defaultLocale' => $site['defaultLocale'],
        'enabledLocales' => zeroy_document_enabled_locales($site, $current_config),
        'translationProfile' => is_array($current_config['translationProfile'] ?? null) ? $current_config['translationProfile'] : ['service' => 'agent', 'model' => 'agent-authored', 'promptVersion' => '1'],
        'siteCopy' => $site_copy,
    ];
    $operations = zeroy_document_media_operations($files, $failures);
    if ($config !== array_diff_key($current_config, ['revision' => true])) $operations[] = ['kind' => 'siteConfig', 'payload' => ['siteConfig' => $config, 'expectedRevision' => (int) ($current_config['revision'] ?? 0)]];
    $owned_entities = [];
    foreach ($documents as $path => $entry) {
        $identity = $entry['identity'];
        if (($identity['kind'] ?? null) !== 'post' || $identity['locale'] !== null) continue;
        $collection = $site['collections'][$identity['collection']] ?? null;
        if (!is_array($collection)) continue;
        $parts = zeroy_document_post_parts($entry['body'], $collection, $schema, $path, $failures);
        $route = is_string($entry['body']['route'] ?? null) ? $entry['body']['route'] : '';
        $found = zeroy_document_find_base_entity($snapshot, $collection, $identity['ref'], $route);
        if ($found === null) {
            $definition = $schema['schemas'][$collection['schemaId']] ?? [];
            $unmanaged = zeroy_adoption_find_unmanaged_post($collection['postType'], $identity['ref'], is_array($definition) ? $definition : []);
            if (is_wp_error($unmanaged)) {
                $failures[] = zeroy_document_failure($unmanaged->get_error_code(), $path, '', $unmanaged->get_error_message(), 'Give every unmanaged WordPress post one unique path-safe slug.');
                continue;
            }
            if ($unmanaged instanceof WP_Post) {
                $existing = zeroy_runtime_existing_post_projection($unmanaged);
                $subject = ['kind' => 'post', 'id' => (int) $unmanaged->ID];
                $operations[] = ['kind' => 'adoptCanonical', 'payload' => ['postId' => (int) $unmanaged->ID, 'ref' => $identity['ref'], 'schemaId' => $collection['schemaId'], 'route' => $route, 'expectedSourceHash' => $existing['sourceHash']]];
                $revision = 1;
                $current_parts = ['postTitle' => (string) $existing['post']['postTitle'], 'postContent' => (string) $existing['post']['postContent'], 'postExcerpt' => (string) $existing['post']['postExcerpt'], 'acf' => is_array($existing['acf'] ?? null) ? $existing['acf'] : []];
                $write = ['objectRef' => (int) $unmanaged->ID, 'expectedRevision' => $revision];
                foreach (['postTitle', 'postContent', 'postExcerpt', 'acf'] as $field) if ($parts[$field] !== $current_parts[$field]) $write[$field] = $parts[$field];
                if (count($write) > 2) { $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => $write]; $revision++; }
                if ($parts['templateContent'] !== []) $operations[] = ['kind' => 'writeTemplateContent', 'payload' => ['objectRef' => (int) $unmanaged->ID, 'templateContent' => $parts['templateContent'], 'expectedRevision' => $revision]];
            } else {
                $subject = ['kind' => 'post', 'ref' => $identity['ref']];
                $operations[] = ['kind' => 'createCanonical', 'payload' => ['ref' => $identity['ref'], 'postType' => $collection['postType'], 'schemaId' => $collection['schemaId'], 'route' => $route, ...$parts]];
                if ($parts['acf'] !== []) $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => ['objectRef' => $identity['ref'], 'acf' => $parts['acf'], 'expectedRevision' => 1]];
            }
            $localizable = zeroy_document_post_localizable($parts, $collection, $schema, $subject);
            if (is_wp_error($localizable)) {
                $failures[] = zeroy_document_failure($localizable->get_error_code(), $path, '', $localizable->get_error_message(), 'Repair the canonical document or ThemeSchema localization policy.');
                continue;
            }
        } else {
            $entity = $found['entity'];
            $owned_entities[$found['identity']] = true;
            $subject = $entity['subject'];
            $revision = (int) $entity['revision'];
            $view = is_array($entity['localizable']['view'] ?? null) ? $entity['localizable']['view'] : [];
            $current_parts = ['postTitle' => (string) ($view['post']['title'] ?? ''), 'postContent' => (string) ($view['post']['content'] ?? ''), 'postExcerpt' => (string) ($view['post']['excerpt'] ?? ''), 'acf' => is_array($view['acf'] ?? null) ? $view['acf'] : [], 'templateContent' => is_array($view['templateContent'] ?? null) ? $view['templateContent'] : []];
            $write = ['objectRef' => (int) $entity['objectId'], 'expectedRevision' => $revision];
            foreach (['postTitle', 'postContent', 'postExcerpt', 'acf'] as $field) if ($parts[$field] !== $current_parts[$field]) $write[$field] = $parts[$field];
            if ($route !== ($entity['route'] ?? null)) $write['route'] = $route;
            if (count($write) > 2) { $operations[] = ['kind' => 'writeCanonicalContent', 'payload' => $write]; $revision++; }
            if ($parts['templateContent'] !== $current_parts['templateContent']) $operations[] = ['kind' => 'writeTemplateContent', 'payload' => ['objectRef' => (int) $entity['objectId'], 'templateContent' => $parts['templateContent'], 'expectedRevision' => $revision]];
            $localizable = zeroy_document_post_localizable($parts, $collection, $schema, $subject);
            if (is_wp_error($localizable)) continue;
        }
        $desired_terms = zeroy_document_term_assignments($entry['body'], $documents, $path, $failures);
        $base_terms = $found !== null && is_array($found['entity']['terms'] ?? null) ? $found['entity']['terms'] : [];
        if ($found === null ? $desired_terms !== [] : $desired_terms !== $base_terms) $operations[] = ['kind' => 'assignTerms', 'payload' => ['objectRef' => $subject['id'] ?? $identity['ref'], 'terms' => $desired_terms]];
        $operations = [...$operations, ...zeroy_document_locale_operations($documents, $site, $snapshot, $subject, $localizable, 'post', ['collection' => $identity['collection'], 'ref' => $identity['ref']], $change_map, $failures)];
    }
    foreach ($snapshot['entities'] ?? [] as $identity => $entity) if (!isset($owned_entities[$identity]) && is_int($entity['objectId'] ?? null)) $operations[] = ['kind' => 'retireCanonical', 'payload' => ['objectId' => $entity['objectId'], 'expectedRevision' => (int) $entity['revision']]];
    $owned_terms = [];
    foreach ($documents as $path => $entry) {
        $identity = $entry['identity'];
        if (($identity['kind'] ?? null) !== 'term' || $identity['locale'] !== null) continue;
        $body = $entry['body'];
        $slug = is_string($body['slug'] ?? null) ? $body['slug'] : '';
        $name = is_string($body['name'] ?? null) ? $body['name'] : '';
        $description = is_string($body['description'] ?? null) ? $body['description'] : '';
        $base_key = $identity['taxonomy'] . ':' . $slug;
        $base = is_array($snapshot['terms'][$base_key] ?? null) ? $snapshot['terms'][$base_key] : null;
        if ($base === null) {
            $unmanaged = zeroy_adoption_find_unmanaged_term($identity['taxonomy'], $identity['ref'], $slug);
            if (is_wp_error($unmanaged)) {
                $failures[] = zeroy_document_failure($unmanaged->get_error_code(), $path, '', $unmanaged->get_error_message(), 'Give every unmanaged term one unique slug.');
                continue;
            }
            if ($unmanaged instanceof WP_Term) {
                $subject = ['kind' => 'term', 'taxonomy' => $identity['taxonomy'], 'id' => (int) $unmanaged->term_id];
                $current = zeroy_localization_term_subject($identity['taxonomy'], $unmanaged->term_id);
                if (is_wp_error($current)) {
                    $failures[] = zeroy_document_failure($current->get_error_code(), $path, '', $current->get_error_message(), 'Repair the unmanaged taxonomy term before adoption.');
                    continue;
                }
                $operations[] = ['kind' => 'adoptTerm', 'payload' => ['termId' => (int) $unmanaged->term_id, 'ref' => $identity['ref'], 'taxonomy' => $identity['taxonomy'], 'slug' => $slug, 'name' => $name, 'description' => $description, 'expectedSourceHash' => (string) $current['canonicalRevision']]];
            } else {
                $subject = ['kind' => 'term', 'taxonomy' => $identity['taxonomy'], 'ref' => $identity['ref']];
                $operations[] = ['kind' => 'createTerm', 'payload' => ['ref' => $identity['ref'], 'taxonomy' => $identity['taxonomy'], 'slug' => $slug, 'name' => $name, 'description' => $description]];
            }
        } else {
            $owned_terms[$base_key] = true;
            $subject = $base['subject'];
            $view = $base['localizable']['view']['term'] ?? [];
            $managed_ref = is_int($subject['id'] ?? null) ? get_term_meta($subject['id'], '_zeroy_authored_ref', true) : null;
            if (is_int($subject['id'] ?? null) && (!is_string($managed_ref) || $managed_ref === '')) {
                $operations[] = ['kind' => 'adoptTerm', 'payload' => ['termId' => $subject['id'], 'ref' => $identity['ref'], 'taxonomy' => $identity['taxonomy'], 'slug' => $slug, 'name' => $name, 'description' => $description, 'expectedSourceHash' => (string) $base['localizable']['canonicalRevision']]];
            } elseif ($name !== ($view['name'] ?? null) || $description !== ($view['description'] ?? null)) $operations[] = ['kind' => 'updateTerm', 'payload' => ['termId' => $subject['id'], 'taxonomy' => $identity['taxonomy'], 'slug' => $slug, 'name' => $name, 'description' => $description, 'expectedSourceHash' => (string) $base['localizable']['canonicalRevision']]];
        }
        $localizable = zeroy_localization_term_subject_from_values($subject, $identity['taxonomy'], $name, $description);
        $term_definition = $schema['localizationSubjects']['term'] ?? null;
        if (is_array($term_definition)) $localizable = zeroy_document_localizable_with_policy($localizable, $term_definition);
        if (is_wp_error($localizable)) { $failures[] = zeroy_document_failure($localizable->get_error_code(), $path, '', $localizable->get_error_message(), 'Repair the term localization policy.'); continue; }
        $operations = [...$operations, ...zeroy_document_locale_operations($documents, $site, $snapshot, $subject, $localizable, 'term', ['taxonomy' => $identity['taxonomy'], 'ref' => $identity['ref']], $change_map, $failures)];
    }
    foreach ($snapshot['terms'] ?? [] as $key => $term) if (!isset($owned_terms[$key]) && is_int($term['subject']['id'] ?? null) && is_string(get_term_meta($term['subject']['id'], '_zeroy_authored_ref', true)) && get_term_meta($term['subject']['id'], '_zeroy_authored_ref', true) !== '') $operations[] = ['kind' => 'retireTerm', 'payload' => ['termId' => $term['subject']['id'], 'taxonomy' => $term['taxonomy'], 'expectedSourceHash' => (string) $term['localizable']['canonicalRevision']]];
    $site_copy_localizable = zeroy_localization_site_copy_subject_from_values($site_copy, (int) ($current_config['revision'] ?? 0) + 1);
    $site_copy_definition = $schema['localizationSubjects']['siteCopy'] ?? null;
    if (!is_wp_error($site_copy_localizable) && is_array($site_copy_definition)) $site_copy_localizable = zeroy_document_localizable_with_policy($site_copy_localizable, $site_copy_definition);
    if (!is_wp_error($site_copy_localizable)) $operations = [...$operations, ...zeroy_document_locale_operations($documents, $site, $snapshot, ['kind' => 'site-copy', 'id' => 'default'], $site_copy_localizable, 'site-copy', [], $change_map, $failures)];
    return $operations;
}
