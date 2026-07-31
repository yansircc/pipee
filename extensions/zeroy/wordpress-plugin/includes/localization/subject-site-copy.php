<?php

defined('ABSPATH') || exit;

function zeroy_localization_site_copy_subject_from_values(array $values, int $revision): array|WP_Error
{
    if (!zeroy_runtime_is_keyed_map($values)) {
        return zeroy_runtime_error('zeroy_site_copy_invalid', 'SiteConfig siteCopy must be a keyed object.', 409);
    }
    $fields = [];
    foreach ($values as $key => $value) {
        if (!is_string($key) || $key === '' || !is_string($value)) {
            return zeroy_runtime_error('zeroy_site_copy_invalid', 'Every SiteCopy value needs a stable key and string canonical value.', 409);
        }
        $fields[] = zeroy_localization_field('/site-copy/' . zeroy_localization_pointer_segment($key), $key, 'site-copy:text', $value, ['siteCopy', $key]);
    }
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => ['kind' => 'site-copy', 'id' => 'default'],
        'schemaId' => 'site-copy',
        'canonicalRevision' => zeroy_runtime_hash(['revision' => $revision, 'fields' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields)]),
        'fields' => $fields,
        'view' => ['siteCopy' => $values],
    ];
}

function zeroy_localization_site_copy_subject(): array|WP_Error
{
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) {
        return $config;
    }
    return zeroy_localization_site_copy_subject_from_values($config['siteCopy'] ?? [], (int) $config['revision']);
}
