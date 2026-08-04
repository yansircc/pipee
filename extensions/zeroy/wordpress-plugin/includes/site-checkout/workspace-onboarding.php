<?php

defined('ABSPATH') || exit;

const ZEROY_WORKSPACE_CONSTRUCTION_MAP_CONTRACT = 'zeroy/workspace-construction-map@1';
const ZEROY_WORKSPACE_CONSTRUCTION_MAP_EXAMPLE_LIMIT = 4;
const ZEROY_WORKSPACE_CONSTRUCTION_MAP_FAILURE_LIMIT = 5;

/**
 * An Agent's initial checkout is a large graph: immutable source files, ACF,
 * ThemeSchema routes, locale contracts, templates, and current build facts.
 * This is a bounded, generated index over that graph. It is deliberately not
 * a second editable task list; every datum is derived from the exact checkout
 * inputs or its BuildResult.
 */
function zeroy_workspace_construction_map_examples(array $paths): array
{
    sort($paths, SORT_STRING);
    return array_slice(array_values(array_unique($paths)), 0, ZEROY_WORKSPACE_CONSTRUCTION_MAP_EXAMPLE_LIMIT);
}

function zeroy_workspace_construction_map_acf_fields(string $post_type): array
{
    $project = static function (array $field) use (&$project): array {
        $summary = [
            'fieldKey' => (string) ($field['key'] ?? ''),
            'name' => (string) ($field['name'] ?? ''),
            'label' => (string) ($field['label'] ?? ''),
            'type' => (string) ($field['type'] ?? ''),
            'required' => !empty($field['required']),
        ];
        if (is_array($field['choices'] ?? null) && $field['choices'] !== []) {
            $summary['choices'] = array_map(
                static fn(mixed $value, mixed $label): array => ['value' => (string) $value, 'label' => (string) $label],
                array_keys($field['choices']),
                $field['choices'],
            );
        }
        $children = [];
        foreach (is_array($field['sub_fields'] ?? null) ? $field['sub_fields'] : [] as $child) {
            if (is_array($child)) $children[] = $project($child);
        }
        if ($children !== []) $summary['children'] = $children;
        return $summary;
    };
    $fields = [];
    foreach (zeroy_document_acf_fields($post_type) as $field) if (is_array($field)) $fields[] = $project($field);
    return $fields;
}

function zeroy_workspace_construction_map_documents(array $files, array $site): array
{
    $collections = [];
    foreach ($site['collections'] as $id => $collection) {
        $collections[$id] = [
            'collectionId' => $id,
            'postType' => (string) $collection['postType'],
            'schemaId' => (string) $collection['schemaId'],
            'canonical' => [],
            'locales' => array_fill_keys(array_values(array_filter($site['locales'], static fn(mixed $locale): bool => is_string($locale) && $locale !== $site['defaultLocale'])), []),
        ];
    }
    $taxonomies = [];
    $media = [];
    $theme_files = [];
    $site_logic_files = [];
    foreach ($files as $path => $_file) {
        if (str_starts_with($path, 'media/')) {
            $media[] = $path;
            continue;
        }
        if (str_starts_with($path, 'artifacts/theme/')) {
            $theme_files[] = $path;
            continue;
        }
        if (str_starts_with($path, 'artifacts/site-logic/')) {
            $site_logic_files[] = $path;
            continue;
        }
        $identity = zeroy_document_path($path, $site);
        if (($identity['kind'] ?? null) === 'post' && isset($collections[$identity['collection'] ?? ''])) {
            $collection_id = (string) $identity['collection'];
            $locale = $identity['locale'] ?? null;
            if (is_string($locale) && isset($collections[$collection_id]['locales'][$locale])) $collections[$collection_id]['locales'][$locale][] = $path;
            elseif ($locale === null) $collections[$collection_id]['canonical'][] = $path;
            continue;
        }
        if (($identity['kind'] ?? null) === 'term' && is_string($identity['taxonomy'] ?? null)) {
            $taxonomy = $identity['taxonomy'];
            $taxonomies[$taxonomy] ??= [
                'taxonomy' => $taxonomy,
                'canonical' => [],
                'locales' => array_fill_keys(array_values(array_filter($site['locales'], static fn(mixed $locale): bool => is_string($locale) && $locale !== $site['defaultLocale'])), []),
            ];
            $locale = $identity['locale'] ?? null;
            if (is_string($locale) && isset($taxonomies[$taxonomy]['locales'][$locale])) $taxonomies[$taxonomy]['locales'][$locale][] = $path;
            elseif ($locale === null) $taxonomies[$taxonomy]['canonical'][] = $path;
        }
    }
    foreach ($collections as &$collection) {
        $canonical = $collection['canonical'];
        $collection['canonical'] = ['count' => count($canonical), 'examples' => zeroy_workspace_construction_map_examples($canonical)];
        foreach ($collection['locales'] as $locale => $paths) {
            $collection['locales'][$locale] = ['count' => count($paths), 'examples' => zeroy_workspace_construction_map_examples($paths)];
        }
        $collection['acfFields'] = zeroy_workspace_construction_map_acf_fields((string) $collection['postType']);
    }
    unset($collection);
    foreach ($taxonomies as &$taxonomy) {
        $canonical = $taxonomy['canonical'];
        $taxonomy['canonical'] = ['count' => count($canonical), 'examples' => zeroy_workspace_construction_map_examples($canonical)];
        foreach ($taxonomy['locales'] as $locale => $paths) {
            $taxonomy['locales'][$locale] = ['count' => count($paths), 'examples' => zeroy_workspace_construction_map_examples($paths)];
        }
    }
    unset($taxonomy);
    ksort($collections, SORT_STRING);
    ksort($taxonomies, SORT_STRING);
    return [
        'collections' => array_values($collections),
        'taxonomies' => array_values($taxonomies),
        'media' => ['count' => count($media), 'examples' => zeroy_workspace_construction_map_examples($media)],
        'artifacts' => [
            'theme' => ['count' => count($theme_files), 'examples' => zeroy_workspace_construction_map_examples($theme_files)],
            'siteLogic' => ['count' => count($site_logic_files), 'examples' => zeroy_workspace_construction_map_examples($site_logic_files)],
        ],
    ];
}

function zeroy_workspace_construction_map_routes(?array $compiled): array
{
    if (!is_array($compiled['schema'] ?? null)) return [];
    $schema = $compiled['schema'];
    $routes = [];
    foreach (is_array($schema['schemas'] ?? null) ? $schema['schemas'] : [] as $schema_id => $definition) {
        if (!is_array($definition)) continue;
        $routes[] = [
            'kind' => 'subject',
            'schemaId' => (string) $schema_id,
            'label' => (string) ($definition['label'] ?? $schema_id),
            'routeKind' => (string) ($definition['routeKind'] ?? ''),
            'template' => (string) ($definition['template'] ?? ''),
            'postTypes' => array_values(array_filter($definition['canonicalPostTypes'] ?? [], 'is_string')),
        ];
    }
    foreach (is_array($schema['collections'] ?? null) ? $schema['collections'] : [] as $id => $definition) {
        if (!is_array($definition)) continue;
        $routes[] = [
            'kind' => (string) ($definition['kind'] ?? 'collection'),
            'collectionId' => (string) $id,
            'label' => (string) ($definition['label'] ?? $id),
            'route' => (string) ($definition['route'] ?? ''),
            'template' => (string) ($definition['template'] ?? ''),
            'schemaId' => (string) ($definition['schemaId'] ?? ''),
            ...(!isset($definition['taxonomy']) ? [] : ['taxonomy' => (string) $definition['taxonomy']]),
        ];
    }
    usort($routes, static fn(array $left, array $right): int => zeroy_checkout_canonical_json($left) <=> zeroy_checkout_canonical_json($right));
    return $routes;
}

function zeroy_workspace_construction_map_diagnostics(array $failures): array
{
    $documents = [];
    $samples = [];
    foreach ($failures as $failure) {
        $path = is_string($failure['documentPath'] ?? null) ? $failure['documentPath'] : 'site.json';
        $documents[$path] ??= ['documentPath' => $path, 'failureCount' => 0, 'codes' => []];
        $documents[$path]['failureCount']++;
        $code = (string) ($failure['code'] ?? 'unknown');
        $documents[$path]['codes'][$code] = true;
        if (count($samples) < ZEROY_WORKSPACE_CONSTRUCTION_MAP_FAILURE_LIMIT) {
            $samples[] = [
                'code' => $code,
                'documentPath' => $path,
                'contentPath' => (string) ($failure['contentPath'] ?? ''),
                'evidence' => (string) ($failure['evidence'] ?? ''),
                'repair' => (string) ($failure['repair'] ?? ''),
            ];
        }
    }
    ksort($documents, SORT_STRING);
    foreach ($documents as &$document) {
        $codes = array_keys($document['codes']);
        sort($codes, SORT_STRING);
        $document['codes'] = $codes;
    }
    unset($document);
    return [
        'failureCount' => count($failures),
        'documents' => array_values($documents),
        'samples' => $samples,
        'detailDirectory' => '.zeroy/diagnostics/',
    ];
}

function zeroy_workspace_construction_map(array $files, array $site, ?array $compiled, array $failures, string $build_id, string $state): array
{
    return [
        'contract' => ZEROY_WORKSPACE_CONSTRUCTION_MAP_CONTRACT,
        'build' => ['buildId' => $build_id, 'state' => $state],
        'authoring' => [
            'editableRoots' => ['site.json', 'artifacts/', 'content/', 'locales/', 'media/'],
            'connectorOwnedRoot' => '.zeroy/',
            'templateSourceRoot' => '.zeroy/templates/',
            'templateCopyRule' => 'Copy a template by removing only the .zeroy/templates/ prefix.',
            'firstRead' => ['.zeroy/brief.json', '.zeroy/construction-map.json', '.zeroy/review.json'],
        ],
        'site' => [
            'defaultLocale' => (string) $site['defaultLocale'],
            'locales' => array_values($site['locales']),
            ...zeroy_workspace_construction_map_documents($files, $site),
            'routes' => zeroy_workspace_construction_map_routes($compiled),
        ],
        'diagnostics' => zeroy_workspace_construction_map_diagnostics($failures),
    ];
}

function zeroy_workspace_construction_map_markdown(array $map): string
{
    $build = is_array($map['build'] ?? null) ? $map['build'] : [];
    $site = is_array($map['site'] ?? null) ? $map['site'] : [];
    $diagnostics = is_array($map['diagnostics'] ?? null) ? $map['diagnostics'] : [];
    $lines = [
        '# zeroY construction map',
        '',
        'Build: ' . (string) ($build['buildId'] ?? ''),
        'State: ' . (string) ($build['state'] ?? ''),
        'Locales: ' . implode(', ', array_filter($site['locales'] ?? [], 'is_string')) . ' (default: ' . (string) ($site['defaultLocale'] ?? '') . ')',
        'Blocking failures: ' . (string) ($diagnostics['failureCount'] ?? 0),
        '',
        'Read construction-map.json for the bounded route, ACF, mock-data, artifact, and diagnostic index. It is generated from this exact checkout and BuildResult; it is not editable work state.',
        '',
        'First failure samples:',
    ];
    foreach (array_slice(is_array($diagnostics['samples'] ?? null) ? $diagnostics['samples'] : [], 0, ZEROY_WORKSPACE_CONSTRUCTION_MAP_FAILURE_LIMIT) as $failure) {
        if (!is_array($failure)) continue;
        $lines[] = '- [' . (string) ($failure['code'] ?? 'unknown') . '] ' . (string) ($failure['documentPath'] ?? 'site.json') . ': ' . (string) ($failure['repair'] ?? 'Read the linked diagnostic.');
    }
    return implode("\n", $lines) . "\n";
}
