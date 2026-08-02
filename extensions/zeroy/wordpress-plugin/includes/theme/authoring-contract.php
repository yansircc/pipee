<?php

defined('ABSPATH') || exit;

/**
 * The Connector publishes this grammar before a first SiteRelease exists.
 * Validators and contract compilation consume the same generators, so an Agent
 * never needs a fixture or Connector source file to discover the bootstrap
 * language.
 */
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
    return [
        'type' => 'object',
        'properties' => [
            'routeKind' => ['type' => 'string'],
            'locale' => ['type' => 'string'],
            'preview' => ['type' => 'boolean'],
            'subject' => ['type' => ['object', 'null']],
            'resolvedContent' => ['type' => ['object', 'null']],
            'searchQuery' => ['type' => ['string', 'null']],
            'archiveItems' => ['type' => 'array'],
            'seo' => ['type' => 'object'],
        ],
        'required' => ['routeKind', 'locale', 'preview', 'subject', 'resolvedContent', 'searchQuery', 'archiveItems', 'seo'],
    ];
}

function zeroy_runtime_theme_authoring_contract(): array
{
    return [
        'contract' => 'zeroy/theme-authoring@1',
        'artifact' => [
            'theme' => [
                'requiredFiles' => zeroy_runtime_theme_required_files(),
                'requiredTemplateRules' => [
                    'Each schemas.*.template, routes.search.template, routes.notFound.template, and collections.*.template must name an existing regular PHP file inside the ThemeArtifact.',
                ],
                'filePolicy' => zeroy_runtime_theme_policy(),
                'manifest' => [
                    'contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT,
                    'required' => ['requiresCapabilities', 'zcss'],
                    'requiresCapabilities' => [
                        'type' => 'keyed-map',
                        'valuePattern' => '^\^[1-9][0-9]*$',
                        'meaning' => 'Only SiteLogic capabilities called by Theme templates belong here. Connector runtime and ZCSS capabilities never belong in this map.',
                        'bootstrapValue' => (object) [],
                        'emptyWhen' => 'Use an empty object when the Theme calls no SiteLogic capability.',
                    ],
                    'zcss' => [
                        'contract' => ZEROY_ZCSS_DESIGN_CONTRACT,
                        'design' => 'zcss.design.json',
                        'styles' => 'An ordered non-empty list of Agent-owned ThemeArtifact CSS paths beginning with the required assets/css/site.css ownership surface.',
                        'generatedPaths' => zeroy_zcss_reserved_paths(),
                    ],
                ],
            ],
        ],
        'themeSchema' => [
            'contract' => ZEROY_THEME_SCHEMA_CONTRACT,
            'required' => ['contract', 'schemas', 'routes'],
            'schemaIdPattern' => '^[a-z][a-z0-9-]{0,95}$',
            'schemas' => [
                'required' => ['label', 'template', 'routeKind', 'canonicalPostTypes', 'localization'],
                'optional' => ['templateContent'],
                'routeKinds' => zeroy_runtime_theme_authoring_route_kinds(),
                'frontPageInvariant' => 'Exactly one schema must declare routeKind front-page.',
                'routeOwnership' => 'A schema must not declare route. Every canonical object supplies its explicit public route.',
            ],
            'routes' => [
                'required' => ['search', 'notFound'],
                'search' => ['required' => ['route', 'template'], 'route' => 'A non-empty normalized relative route.'],
                'notFound' => ['required' => ['template']],
            ],
            'collections' => [
                'optional' => true,
                'collectionIdPattern' => '^[a-z][a-z0-9-]{0,95}$',
                'kinds' => zeroy_runtime_theme_authoring_collection_kinds(),
                'required' => ['kind', 'label', 'route', 'template', 'schemaId'],
                'taxonomyRequires' => ['taxonomy'],
                'routeInvariant' => 'Collection routes cannot overlap and reserve their complete archive or taxonomy route space.',
            ],
            'localization' => [
                'contract' => zeroy_localization_policy_contract(),
                'ruleRoots' => ['post', 'acf', 'term', 'menu', 'site-copy', 'media', 'template-content'],
                'modes' => zeroy_localization_field_policy_modes(),
                'contextWeights' => zeroy_localization_field_policy_context_weights(),
                'requiredInvariant' => 'required may be true only when mode is translated.',
                'repeaterItemKeys' => 'A keyed map from a repeater JSON pointer to its stable ACF item-key field.',
            ],
            'localizationSubjects' => [
                'optional' => true,
                'kinds' => zeroy_runtime_theme_authoring_localization_subject_kinds(),
                'required' => ['localization'],
            ],
            'templateContent' => [
                'optional' => true,
                'keyPattern' => '^[a-z][a-z0-9_]{0,95}$',
                'field' => [
                    'required' => ['kind', 'searchable', 'localization'],
                    'kind' => 'text',
                    'searchable' => 'boolean',
                ],
            ],
        ],
        'renderContext' => zeroy_runtime_theme_render_context_schema(),
        'routeSemantics' => [
            'localeAvailability' => 'Every declared collection route is available for every enabled locale; an empty collection renders its template with an empty archiveItems array.',
            'search' => 'Search is an explicit RouteSpec route and must render routeKind search rather than a canonical page.',
            'templates' => 'Templates consume only zeroy_theme_context(); they must not resolve preview, locale, Draft, or SiteRelease state themselves.',
        ],
    ];
}
