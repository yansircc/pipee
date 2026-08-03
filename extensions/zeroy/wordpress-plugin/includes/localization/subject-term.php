<?php

defined('ABSPATH') || exit;

function zeroy_localization_term_subject_from_values(array $subject, string $taxonomy, string $name, string $description): array
{
    $fields = [
        zeroy_localization_field('/term/name', 'Term name', 'term:name', $name, ['term', 'name']),
        zeroy_localization_field('/term/description', 'Term description', 'term:description', $description, ['term', 'description']),
    ];
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => $subject,
        'schemaId' => 'term',
        'canonicalRevision' => zeroy_runtime_hash(['taxonomy' => $taxonomy, 'fields' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields)]),
        'fields' => $fields,
        'view' => ['term' => ['name' => $name, 'description' => $description]],
    ];
}

function zeroy_localization_term_subject(string $taxonomy, int $term_id): array|WP_Error
{
    $term = get_term($term_id, $taxonomy);
    if (!$term instanceof WP_Term) {
        return zeroy_runtime_error('zeroy_localization_term_missing', 'Canonical taxonomy term does not exist.', 404);
    }
    return zeroy_localization_term_subject_from_values(['kind' => 'term', 'taxonomy' => $taxonomy, 'id' => $term_id], $taxonomy, $term->name, $term->description);
}
