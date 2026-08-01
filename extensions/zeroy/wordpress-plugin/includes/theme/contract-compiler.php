<?php

defined('ABSPATH') || exit;

const ZEROY_THEME_CONTRACT = 'zeroy/theme-contract@1';
const ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT = 'zeroy/theme-manifest@2';

function zeroy_runtime_theme_runtime_manifest(string $directory): array|WP_Error
{
    $path = rtrim($directory, '/') . '/zeroy.theme.json';
    if (!is_file($path) || is_link($path)) {
        return zeroy_runtime_error('zeroy_theme_manifest_missing', 'ThemeArtifact requires zeroy.theme.json declaring its capability requirements.', 409);
    }
    $decoded = zeroy_runtime_decode_json((string) file_get_contents($path));
    if (is_wp_error($decoded) || ($decoded['contract'] ?? null) !== ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT || !is_array($decoded['requiresCapabilities'] ?? null) || !zeroy_runtime_is_keyed_map($decoded['requiresCapabilities'])) {
        return zeroy_runtime_error('zeroy_theme_manifest_invalid', 'zeroy.theme.json must contain ThemeManifest contract and keyed requiresCapabilities.', 409);
    }
    $requirements = [];
    foreach ($decoded['requiresCapabilities'] as $capability => $version) {
        $reference = zeroy_runtime_normalize_capability_reference(['capability' => $capability, 'version' => $version]);
        if (is_wp_error($reference)) return $reference;
        $requirements[$reference['capability']] = $reference;
    }
    ksort($requirements, SORT_STRING);
    return ['contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT, 'requiresCapabilities' => $requirements];
}

function zeroy_runtime_compile_theme_contract_from_directories(string $theme_directory, string $site_logic_directory): array|WP_Error
{
    $schema = zeroy_runtime_schema_diagnostics_from_path($theme_directory . '/zeroy.schema.json', $theme_directory);
    if (!$schema['valid']) return zeroy_runtime_error('zeroy_theme_contract_schema_invalid', 'ThemeArtifact has an invalid ThemeSchema.', 409, ['violations' => $schema['errors']]);
    $theme_manifest = zeroy_runtime_theme_runtime_manifest($theme_directory);
    if (is_wp_error($theme_manifest)) return $theme_manifest;
    $site_logic_contract = zeroy_runtime_site_logic_contract_from_directory($site_logic_directory);
    if (is_wp_error($site_logic_contract)) return zeroy_runtime_error('zeroy_site_logic_contract_invalid', 'Stored SiteLogicContract is invalid.', 409);
    $runtime_contract = ['provides' => [
        ['capability' => 'locale.resolve', 'version' => '1'],
        ['capability' => 'collection.query', 'version' => '1'],
    ]];
    $missing_runtime = zeroy_runtime_capability_requirements_satisfied($site_logic_contract['requires'], $runtime_contract);
    if (is_wp_error($missing_runtime)) return $missing_runtime;
    if ($missing_runtime !== []) return zeroy_runtime_error('zeroy_site_logic_requirement_missing', 'SiteLogicArtifact requires unavailable Connector runtime capabilities.', 409, ['missing' => $missing_runtime]);
    $missing = zeroy_runtime_capability_requirements_satisfied(array_values($theme_manifest['requiresCapabilities']), $site_logic_contract);
    if (is_wp_error($missing)) return $missing;
    if ($missing !== []) return zeroy_runtime_error('zeroy_capability_missing', 'ThemeArtifact requires capabilities not provided by SiteLogicArtifact.', 409, ['missing' => $missing]);
    $config = zeroy_runtime_site_config();
    if (is_wp_error($config)) return $config;
    $content_schemas = [];
    $templates = [];
    foreach ($schema['schema']['schemas'] as $schema_id => $definition) {
        $content_schemas[] = [
            'schemaId' => $schema_id,
            'label' => $definition['label'],
            'canonicalPostTypes' => $definition['canonicalPostTypes'],
            'template' => $definition['template'],
            'routeKind' => $definition['routeKind'],
            'localizationHash' => zeroy_runtime_hash($definition['localization']),
        ];
    }
    $collections = [];
    foreach ($schema['schema']['collections'] ?? [] as $collection_id => $collection) {
        $collections[] = ['collectionId' => $collection_id, ...$collection];
    }
    $requirements = array_values($theme_manifest['requiresCapabilities']);
    $render_context_input = zeroy_runtime_theme_render_context_schema();
    foreach ($content_schemas as $content_schema) {
        $templates[] = [
            'templateId' => $content_schema['routeKind'] . ':' . $content_schema['schemaId'],
            'kind' => $content_schema['routeKind'],
            'inputSchema' => $render_context_input,
            'requiredCapabilities' => $requirements,
        ];
    }
    foreach ($collections as $collection) {
        $templates[] = [
            'templateId' => 'collection:' . $collection['collectionId'],
            'kind' => $collection['kind'] === 'taxonomy' ? 'taxonomy' : 'archive',
            'inputSchema' => $render_context_input,
            'requiredCapabilities' => $requirements,
        ];
    }
    if (!is_array($schema['schema']['routes'] ?? null)) {
        return zeroy_runtime_error('zeroy_route_spec_missing', 'ThemeSchema must declare RouteSpec before it can become a SiteRelease.', 409, ['field' => 'routes']);
    }
    $templates[] = ['templateId' => 'search', 'kind' => 'search', 'inputSchema' => $render_context_input, 'requiredCapabilities' => $requirements];
    $templates[] = ['templateId' => '404', 'kind' => '404', 'inputSchema' => $render_context_input, 'requiredCapabilities' => $requirements];
    $contract = [
        'contract' => ZEROY_THEME_CONTRACT,
        'site' => ['siteId' => zeroy_runtime_site_id(), 'defaultLocale' => $config['defaultLocale'], 'enabledLocales' => array_map(static fn(array $locale): array => ['locale' => $locale['locale'], 'urlPrefix' => $locale['urlPrefix']], $config['enabledLocales'])],
        'contentSchemas' => $content_schemas,
        'collectionRoutes' => $collections,
        'routeSpec' => $schema['schema']['routes'],
        'mediaContract' => ['contract' => 'zeroy/media-projection@1'],
        'localeContract' => ['contract' => 'zeroy/locale-projection@1', 'policyHash' => zeroy_runtime_hash(['schemas' => $schema['schema']['schemas'], 'subjects' => $schema['schema']['localizationSubjects'] ?? []])],
        'runtimeCapabilities' => [
            ['capability' => 'locale.resolve', 'version' => '^1'],
            ['capability' => 'collection.query', 'version' => '^1'],
        ],
        'siteLogicCapabilities' => array_map(static fn(array $provided): array => ['capability' => $provided['capability'], 'version' => '^' . $provided['version']], $site_logic_contract['provides']),
        'templates' => $templates,
    ];
    return ['contract' => $contract, 'hash' => zeroy_runtime_hash($contract), 'schema' => $schema['schema'], 'schemaHash' => $schema['contractHash'], 'siteLogicContract' => $site_logic_contract, 'siteLogicContractHash' => zeroy_runtime_hash($site_logic_contract)];
}

/**
 * Artifact identifiers select immutable bytes.  Contract compilation itself
 * is defined over those bytes, so Draft inspection and release preparation
 * share this one compiler rather than maintaining separate schema readers.
 */
function zeroy_runtime_compile_theme_contract(string $theme_artifact_id, string $site_logic_artifact_id): array|WP_Error
{
    $theme = zeroy_runtime_artifact_row($theme_artifact_id);
    $logic = zeroy_runtime_site_logic_artifact_row($site_logic_artifact_id);
    if ($theme === null || $logic === null) return zeroy_runtime_error('zeroy_contract_artifact_missing', 'ThemeArtifact and SiteLogicArtifact must exist before compiling ThemeContract.', 409);
    return zeroy_runtime_compile_theme_contract_from_directories(
        zeroy_runtime_artifact_directory($theme_artifact_id),
        zeroy_runtime_site_logic_directory($site_logic_artifact_id),
    );
}
