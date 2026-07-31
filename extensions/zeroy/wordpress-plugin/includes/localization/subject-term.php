<?php

defined('ABSPATH') || exit;

function zeroy_localization_term_subject(string $taxonomy, int $term_id): array|WP_Error
{
    $term = get_term($term_id, $taxonomy);
    if (!$term instanceof WP_Term) {
        return zeroy_runtime_error('zeroy_localization_term_missing', 'Canonical taxonomy term does not exist.', 404);
    }
    $fields = [
        zeroy_localization_field('/term/name', 'Term name', 'term:name', $term->name, ['term', 'name']),
        zeroy_localization_field('/term/description', 'Term description', 'term:description', $term->description, ['term', 'description']),
    ];
    return [
        'contract' => 'zeroy/localizable-subject@1',
        'subject' => ['kind' => 'term', 'taxonomy' => $taxonomy, 'id' => $term_id],
        'schemaId' => 'term',
        'canonicalRevision' => zeroy_runtime_hash(['termTaxonomyId' => $term->term_taxonomy_id, 'fields' => array_map(static fn(array $field): array => ['fieldId' => $field['fieldId'], 'sourceHash' => $field['sourceHash']], $fields)]),
        'fields' => $fields,
        'view' => ['term' => ['name' => $term->name, 'description' => $term->description]],
    ];
}
