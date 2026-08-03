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

function zeroy_runtime_theme_render_context_schema(): array
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
            'resolvedContent' => ['type' => 'object'],
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
