<?php

defined('ABSPATH') || exit;

function zeroy_runtime_theme_authoring_route_kinds(): array
{
    return ['front-page', 'document', 'singular'];
}

function zeroy_runtime_theme_authoring_collection_kinds(): array
{
    return ['post-archive', 'taxonomy'];
}

function zeroy_runtime_theme_authoring_localization_subject_kinds(): array
{
    return ['term', 'menu', 'siteCopy', 'media'];
}

function zeroy_runtime_theme_acf_view_field_schema(array $field): array
{
    $type = (string) ($field['type'] ?? '');
    if ($type === 'group') {
        $properties = [];
        foreach (is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [] as $child) {
            $key = (string) ($child['key'] ?? '');
            if ($key !== '') $properties[$key] = zeroy_runtime_theme_acf_view_field_schema($child);
        }
        return ['type' => 'object', 'additionalProperties' => false, 'properties' => zeroy_runtime_json_map($properties)];
    }
    if (in_array($type, ['repeater', 'flexible_content'], true)) {
        $rows = [];
        $layouts = $type === 'flexible_content'
            ? (is_array($field['layouts'] ?? null) ? $field['layouts'] : [])
            : [['sub_fields' => is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : []]];
        foreach ($layouts as $layout) {
            $properties = [];
            if ($type === 'flexible_content') $properties['acf_fc_layout'] = ['const' => (string) ($layout['name'] ?? '')];
            foreach (is_array($layout['sub_fields'] ?? null) ? $layout['sub_fields'] : [] as $child) {
                $key = (string) ($child['key'] ?? '');
                if ($key !== '') $properties[$key] = zeroy_runtime_theme_acf_view_field_schema($child);
            }
            $rows[] = ['type' => 'object', 'additionalProperties' => false, 'properties' => zeroy_runtime_json_map($properties)];
        }
        return ['type' => 'object', 'additionalProperties' => count($rows) === 1 ? $rows[0] : ['oneOf' => $rows]];
    }
    $multiple_reference = static fn(string $kind): array => [
        'type' => 'array',
        'items' => ['type' => 'integer', 'minimum' => 1, 'description' => "WordPress {$kind} ID."],
    ];
    $single_reference = static fn(string $kind): array => [
        'oneOf' => [
            ['type' => 'integer', 'minimum' => 1, 'description' => "WordPress {$kind} ID."],
            ['type' => 'null'],
        ],
    ];
    $schema = match ($type) {
        'number', 'range' => ['type' => 'number'],
        'true_false' => ['type' => 'boolean'],
        'checkbox' => ['type' => 'array', 'items' => ['type' => 'string']],
        'gallery' => $multiple_reference('attachment'),
        'relationship' => $multiple_reference('post'),
        'image', 'file' => $single_reference('attachment'),
        'post_object' => !empty($field['multiple']) ? $multiple_reference('post') : $single_reference('post'),
        'taxonomy' => !empty($field['multiple']) || !empty($field['add_term']) ? $multiple_reference('term') : $single_reference('term'),
        'link', 'google_map' => ['type' => 'object'],
        default => ['type' => 'string'],
    };
    if (is_array($field['choices'] ?? null) && $field['choices'] !== []) {
        $choices = array_map('strval', array_keys($field['choices']));
        if ($type === 'checkbox') $schema['items']['enum'] = $choices;
        else $schema['enum'] = $choices;
    }
    $schema['description'] = 'ThemeRenderContext stable ACF field key ' . (string) ($field['key'] ?? '') . '; current WordPress field name ' . (string) ($field['name'] ?? '') . '.';
    return $schema;
}

function zeroy_runtime_theme_resolved_content_schema(string $post_type, array $definition): array
{
    $acf = [];
    if (function_exists('zeroy_document_acf_fields')) foreach (zeroy_document_acf_fields($post_type) as $field) {
        $key = (string) ($field['key'] ?? '');
        if ($key !== '') $acf[$key] = zeroy_runtime_theme_acf_view_field_schema($field);
    }
    $template = [];
    foreach (is_array($definition['templateContent'] ?? null) ? $definition['templateContent'] : [] as $name => $_declaration) $template[(string) $name] = ['type' => 'string'];
    return [
        'type' => 'object',
        'properties' => zeroy_runtime_json_map([
            'post' => ['type' => 'object', 'additionalProperties' => false, 'properties' => zeroy_runtime_json_map(['title' => ['type' => 'string'], 'content' => ['type' => 'string'], 'excerpt' => ['type' => 'string']])],
            'acf' => ['type' => 'object', 'additionalProperties' => false, 'properties' => zeroy_runtime_json_map($acf)],
            'templateContent' => ['type' => 'object', 'additionalProperties' => false, 'properties' => zeroy_runtime_json_map($template)],
            'siteCopy' => ['type' => 'object'],
            '_entities' => ['type' => 'object'],
            '_site' => ['type' => 'object'],
        ]),
        'required' => ['post', 'acf', 'templateContent'],
    ];
}

function zeroy_runtime_theme_render_context_schema(array $resolved_variants = []): array
{
    $entity = [
        'type' => 'object',
        'additionalProperties' => false,
        'properties' => [
            'objectId' => ['type' => ['integer', 'null']],
            'subject' => ['type' => 'object'],
            'locale' => ['type' => 'string'],
            'schemaId' => ['type' => 'string'],
            'route' => ['type' => 'string'],
            'url' => ['type' => 'string'],
            'fields' => ['type' => 'object'],
        ],
        'required' => ['objectId', 'subject', 'locale', 'schemaId', 'route', 'url', 'fields'],
    ];
    return [
        '$schema' => 'https://json-schema.org/draft/2020-12/schema',
        'type' => 'object',
        'additionalProperties' => false,
        'properties' => [
            'routeKind' => ['enum' => ['front-page', 'document', 'singular', 'archive', 'taxonomy', 'search', 'not-found']],
            'locale' => ['type' => 'string'],
            'preview' => ['type' => 'boolean'],
            'subject' => ['type' => ['object', 'null']],
            'resolvedContent' => $resolved_variants === [] ? ['type' => 'object'] : ['anyOf' => array_values($resolved_variants)],
            'searchQuery' => ['type' => ['string', 'null']],
            'archiveItems' => ['type' => 'array', 'items' => $entity],
            'collection' => [
                'anyOf' => [
                    ['type' => 'null'],
                    [
                        'type' => 'object',
                        'additionalProperties' => false,
                        'properties' => [
                            'collectionId' => ['type' => ['string', 'null']],
                            'schemaId' => ['type' => ['string', 'null']],
                            'title' => ['type' => ['string', 'null']],
                            'page' => ['type' => 'integer'],
                            'perPage' => ['type' => 'integer'],
                            'total' => ['type' => 'integer'],
                        ],
                        'required' => ['collectionId', 'schemaId', 'title', 'page', 'perPage', 'total'],
                    ],
                ],
            ],
            'seo' => [
                'type' => 'object',
                'additionalProperties' => false,
                'properties' => ['canonical' => ['type' => ['string', 'null']], 'alternates' => ['type' => 'object']],
                'required' => ['canonical', 'alternates'],
            ],
        ],
        'required' => ['routeKind', 'locale', 'preview', 'subject', 'resolvedContent', 'searchQuery', 'archiveItems', 'collection', 'seo'],
    ];
}
