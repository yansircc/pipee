<?php

defined('ABSPATH') || exit;

const ZEROY_THEME_CONTRACT = 'zeroy/theme-contract@2';
const ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT = 'zeroy/theme-manifest@3';

function zeroy_runtime_theme_runtime_manifest(string $directory): array|WP_Error
{
    $path = rtrim($directory, '/') . '/zeroy.theme.json';
    if (!is_file($path) || is_link($path)) {
        return zeroy_runtime_error('zeroy_theme_manifest_missing', 'ThemeArtifact requires zeroy.theme.json declaring its capability requirements.', 409);
    }
    $decoded = zeroy_runtime_decode_json((string) file_get_contents($path));
    if (
        is_wp_error($decoded) || !zeroy_runtime_is_keyed_map($decoded) ||
        count($decoded) !== 3 || array_diff(array_keys($decoded), ['contract', 'requiresCapabilities', 'zcss']) !== [] ||
        ($decoded['contract'] ?? null) !== ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT ||
        !is_array($decoded['requiresCapabilities'] ?? null) || !zeroy_runtime_is_keyed_map($decoded['requiresCapabilities']) ||
        !zeroy_runtime_is_keyed_map($decoded['zcss'] ?? null) ||
        count($decoded['zcss']) !== 3 || array_diff(array_keys($decoded['zcss']), ['contract', 'design', 'styles']) !== [] ||
        ($decoded['zcss']['contract'] ?? null) !== ZEROY_ZCSS_DESIGN_CONTRACT ||
        ($decoded['zcss']['design'] ?? null) !== 'zcss.design.json' ||
        !is_array($decoded['zcss']['styles'] ?? null) || !array_is_list($decoded['zcss']['styles']) || $decoded['zcss']['styles'] === []
    ) {
        return zeroy_runtime_error('zeroy_theme_manifest_invalid', 'zeroy.theme.json must be an exact ThemeManifest v3 with requiresCapabilities and the ZCSS design/style declaration.', 409);
    }
    if (count($decoded['zcss']['styles']) >= ZEROY_ZCSS_STYLE_SURFACE_MAX_STYLESHEETS) {
        return zeroy_runtime_error('zeroy_theme_manifest_style_limit', 'ThemeManifest declares too many custom stylesheets for one bounded StyleSurface.', 409, ['limit' => ZEROY_ZCSS_STYLE_SURFACE_MAX_STYLESHEETS - 1]);
    }
    $requirements = [];
    foreach ($decoded['requiresCapabilities'] as $capability => $version) {
        $reference = zeroy_runtime_normalize_capability_reference(['capability' => $capability, 'version' => $version]);
        if (is_wp_error($reference)) {
            $data = $reference->get_error_data();
            return zeroy_runtime_error(
                $reference->get_error_code(),
                $reference->get_error_message(),
                400,
                (is_array($data) ? array_diff_key($data, ['status' => true]) : []) + [
                    'fieldId' => '/requiresCapabilities/' . str_replace(['~', '/'], ['~0', '~1'], (string) $capability),
                    'repair' => 'Use {} unless the Theme calls a capability provided by the pinned SiteLogicArtifact; otherwise use that exact capability name with a value such as ^1.',
                ],
            );
        }
        $requirements[$reference['capability']] = $reference;
    }
    ksort($requirements, SORT_STRING);
    $styles = [];
    foreach ($decoded['zcss']['styles'] as $index => $style) {
        if (
            !is_string($style) || !zeroy_runtime_artifact_path_valid($style) || zeroy_runtime_artifact_path_forbidden($style) ||
            !str_ends_with(strtolower($style), '.css') || zeroy_runtime_theme_generated_path($style) || isset($styles[$style])
        ) {
            return zeroy_runtime_error('zeroy_theme_manifest_style_invalid', 'ThemeManifest zcss.styles must contain unique safe ThemeArtifact CSS paths.', 409, ['fieldId' => '/zcss/styles/' . $index, 'path' => $style]);
        }
        $path = rtrim($directory, '/') . '/' . $style;
        if (!is_file($path) || is_link($path)) return zeroy_runtime_error('zeroy_theme_manifest_style_missing', 'ThemeManifest references a missing or unsafe custom stylesheet.', 409, ['fieldId' => '/zcss/styles/' . $index, 'path' => $style]);
        $styles[$style] = true;
    }
    if (!isset($styles['assets/css/site.css'])) {
        return zeroy_runtime_error('zeroy_theme_manifest_style_missing', 'ThemeManifest must declare assets/css/site.css as an Agent-owned stylesheet.', 409, ['fieldId' => '/zcss/styles']);
    }
    $design_path = rtrim($directory, '/') . '/zcss.design.json';
    if (!is_file($design_path) || is_link($design_path)) return zeroy_runtime_error('zeroy_zcss_design_missing', 'ThemeArtifact requires a regular zcss.design.json.', 409, ['fieldId' => '/zcss/design']);
    return [
        'contract' => ZEROY_THEME_RUNTIME_MANIFEST_CONTRACT,
        'requiresCapabilities' => $requirements,
        'zcss' => ['contract' => ZEROY_ZCSS_DESIGN_CONTRACT, 'design' => 'zcss.design.json', 'styles' => array_keys($styles)],
    ];
}

function zeroy_runtime_compile_theme_contract_from_directories(string $theme_directory, string $site_logic_directory): array|WP_Error
{
    foreach (zeroy_runtime_theme_required_files() as $required_file) {
        $required_path = rtrim($theme_directory, '/') . '/' . $required_file;
        if (!is_file($required_path) || is_link($required_path)) {
            return zeroy_runtime_error(
                'zeroy_theme_required_file_missing',
                'ThemeArtifact is missing a required regular file.',
                409,
                [
                    'path' => $required_file,
                    'requiredFiles' => zeroy_runtime_theme_required_files(),
                    'repair' => 'Stage the complete ThemeArtifact requiredFiles projection before compiling or committing the SiteCheckout.',
                ],
            );
        }
    }
    $schema = zeroy_runtime_schema_diagnostics_from_path($theme_directory . '/zeroy.schema.json', $theme_directory);
    if (!$schema['valid']) return zeroy_runtime_error('zeroy_theme_contract_schema_invalid', 'ThemeArtifact has an invalid ThemeSchema.', 409, ['violations' => $schema['errors']]);
    $theme_manifest = zeroy_runtime_theme_runtime_manifest($theme_directory);
    if (is_wp_error($theme_manifest)) return $theme_manifest;
    $unit_assets = zeroy_runtime_theme_unit_compiled_assets($theme_directory);
    if (is_wp_error($unit_assets)) return $unit_assets;
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
    foreach ($content_schemas as $content_schema) {
        $post_type = (string) ($content_schema['canonicalPostTypes'][0] ?? '');
        $definition = $schema['schema']['schemas'][$content_schema['schemaId']];
        $templates[] = [
            'templateId' => $content_schema['routeKind'] . ':' . $content_schema['schemaId'],
            'kind' => $content_schema['routeKind'],
            'inputSchema' => zeroy_runtime_theme_render_context_schema([
                zeroy_runtime_theme_resolved_content_schema($post_type, $definition),
            ]),
            'requiredCapabilities' => $requirements,
        ];
    }
    foreach ($collections as $collection) {
        $definition = $schema['schema']['schemas'][$collection['schemaId']] ?? [];
        $post_type = (string) (($definition['canonicalPostTypes'] ?? [])[0] ?? '');
        $templates[] = [
            'templateId' => 'collection:' . $collection['collectionId'],
            'kind' => $collection['kind'] === 'taxonomy' ? 'taxonomy' : 'archive',
            'inputSchema' => zeroy_runtime_theme_render_context_schema($post_type === '' ? [] : [zeroy_runtime_theme_resolved_content_schema($post_type, $definition)]),
            'requiredCapabilities' => $requirements,
        ];
    }
    if (!is_array($schema['schema']['routes'] ?? null)) {
        return zeroy_runtime_error('zeroy_route_spec_missing', 'ThemeSchema must declare RouteSpec before it can become a SiteRelease.', 409, ['field' => 'routes']);
    }
    $generic_render_context = zeroy_runtime_theme_render_context_schema();
    $templates[] = ['templateId' => 'search', 'kind' => 'search', 'inputSchema' => $generic_render_context, 'requiredCapabilities' => $requirements];
    $templates[] = ['templateId' => '404', 'kind' => '404', 'inputSchema' => $generic_render_context, 'requiredCapabilities' => $requirements];
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
        'themeProgram' => $unit_assets['themeProgram'],
        'stylesheets' => [ZEROY_ZCSS_GENERATED_CSS_PATH, ...$unit_assets['stylesheets'], ...$theme_manifest['zcss']['styles']],
        'scripts' => $unit_assets['scripts'],
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
