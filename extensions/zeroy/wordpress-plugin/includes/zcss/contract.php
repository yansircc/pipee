<?php

defined('ABSPATH') || exit;

const ZEROY_ZCSS_DESIGN_CONTRACT = 'zeroy/zcss-design@1';
const ZEROY_ZCSS_COMPILED_CONTRACT = 'zeroy/zcss-compiled-contract@1';
const ZEROY_ZCSS_COMPILER_ID = 'zeroy/zcss-compiler@1';
const ZEROY_ZCSS_COMPILER_VERSION = '1.0.0';
// Generated from the closed compiler source set. Tests reject algorithm edits
// that do not deliberately advance this immutable compiler identity.
const ZEROY_ZCSS_COMPILER_SOURCE_HASH = '3d0af86be12d87d7a6c7b6be4bae724341fa6e16b627277996364a22a785a7c7';
const ZEROY_ZCSS_STYLE_SURFACE_CONTRACT = 'zeroy/style-surface@2';
const ZEROY_ZCSS_GENERATED_CSS_PATH = 'assets/css/zcss.generated.css';
const ZEROY_ZCSS_COMPILED_MANIFEST_PATH = 'assets/css/zcss.manifest.json';
const ZEROY_ZCSS_STYLE_SURFACE_MAX_STYLESHEETS = 32;
const ZEROY_ZCSS_STYLE_SURFACE_MAX_BYTES = 2_000_000;
const ZEROY_ZCSS_STYLE_SURFACE_MAX_NODES = 10_000;
const ZEROY_ZCSS_STYLE_SURFACE_MAX_DECLARATIONS = 10_000;
const ZEROY_ZCSS_STYLE_SURFACE_MAX_NESTING = 64;

function zeroy_zcss_reserved_paths(): array
{
    return [ZEROY_ZCSS_GENERATED_CSS_PATH, ZEROY_ZCSS_COMPILED_MANIFEST_PATH];
}

function zeroy_zcss_browser_policy(): array
{
    return [
        'contract' => 'zeroy/zcss-browser-policy@1',
        'colorSpace' => 'srgb',
        'contrast' => ['normalText' => 4.5, 'largeText' => 3.0, 'ui' => 3.0],
        'viewports' => ['mobile' => 360, 'tablet' => 768, 'desktop' => 1440],
        'features' => ['containerQueries' => true, 'logicalProperties' => true, 'oklchAuthoring' => false],
    ];
}

function zeroy_zcss_contrast_pairs(): array
{
    return [
        ['id' => 'surface', 'foreground' => '--z-color-on-surface', 'background' => '--z-color-surface', 'minimum' => 4.5],
        ['id' => 'action', 'foreground' => '--z-color-on-action', 'background' => '--z-color-action', 'minimum' => 4.5],
        ['id' => 'success', 'foreground' => '--z-color-on-status-success', 'background' => '--z-color-status-success', 'minimum' => 4.5],
        ['id' => 'warning', 'foreground' => '--z-color-on-status-warning', 'background' => '--z-color-status-warning', 'minimum' => 4.5],
        ['id' => 'danger', 'foreground' => '--z-color-on-status-danger', 'background' => '--z-color-status-danger', 'minimum' => 4.5],
    ];
}

function zeroy_zcss_design_spec(): array
{
    $number = static fn(float $min, float $max): array => ['kind' => 'number', 'minimum' => $min, 'maximum' => $max];
    $object = static fn(array $properties): array => ['kind' => 'object', 'properties' => $properties];
    return $object([
        'contract' => ['kind' => 'literal', 'value' => ZEROY_ZCSS_DESIGN_CONTRACT],
        'palette' => $object([
            'brand' => $object(['color' => ['kind' => 'color']]),
            'accent' => $object(['color' => ['kind' => 'color']]),
            'neutral' => $object(['color' => ['kind' => 'color']]),
            'success' => $object(['color' => ['kind' => 'color']]),
            'warning' => $object(['color' => ['kind' => 'color']]),
            'danger' => $object(['color' => ['kind' => 'color']]),
        ]),
        'typography' => $object([
            'viewport' => $object(['minPx' => $number(240, 1600), 'maxPx' => $number(480, 3840)]),
            'body' => $object(['minPx' => $number(12, 32), 'maxPx' => $number(12, 40)]),
            'scaleRatio' => $number(1.05, 2),
            'headingScaleRatio' => $number(1.05, 2),
            'bodyLineHeight' => $number(1, 2.2),
            'headingLineHeight' => $number(0.9, 1.8),
            'bodyFamily' => ['kind' => 'font-family', 'maxLength' => 200],
            'headingFamily' => ['kind' => 'font-family', 'maxLength' => 200],
        ]),
        'spacing' => $object(['minPx' => $number(1, 32), 'maxPx' => $number(1, 64), 'scaleRatio' => $number(1.05, 3), 'sectionMultiplier' => $number(2, 16)]),
        'layout' => $object(['contentWidth' => $number(480, 2400), 'textWidth' => $number(320, 1200), 'gutterMin' => $number(8, 64), 'gutterMax' => $number(8, 128)]),
        'shape' => $object(['radiusBase' => $number(0, 48), 'borderWidth' => $number(0, 8), 'shadowStrength' => $number(0, 1)]),
        'motion' => $object(['durationFast' => $number(0, 2000), 'durationNormal' => $number(0, 5000), 'easingStandard' => ['kind' => 'easing']]),
    ]);
}

function zeroy_zcss_json_schema_from_spec(array $spec): array
{
    return match ($spec['kind']) {
        'object' => [
            'type' => 'object',
            'additionalProperties' => false,
            'properties' => array_map('zeroy_zcss_json_schema_from_spec', $spec['properties']),
            'required' => array_keys($spec['properties']),
        ],
        'literal' => ['type' => 'string', 'const' => $spec['value']],
        'number' => ['type' => 'number', 'minimum' => $spec['minimum'], 'maximum' => $spec['maximum']],
        'color' => ['type' => 'string', 'pattern' => '^#[0-9a-fA-F]{6}$', 'description' => 'Six-digit normalized sRGB hexadecimal color.'],
        'font-family' => ['type' => 'string', 'minLength' => 1, 'maxLength' => $spec['maxLength'], 'description' => 'Local or system CSS font-family declaration; it never triggers a network download.'],
        'easing' => ['type' => 'string', 'description' => 'CSS easing keyword or cubic-bezier() value.'],
    };
}

function zeroy_zcss_design_json_schema(): array
{
    return zeroy_zcss_json_schema_from_spec(zeroy_zcss_design_spec());
}

function zeroy_zcss_public_primitives(): array
{
    return array_map(
        static fn(array $definition): array => array_intersect_key($definition, ['className' => true, 'purpose' => true, 'configurableProperties' => true]),
        zeroy_zcss_primitive_definitions(),
    );
}

function zeroy_zcss_minimal_design_document(): array
{
    return [
        'contract' => ZEROY_ZCSS_DESIGN_CONTRACT,
        'palette' => [
            'brand' => ['color' => '#1f5eff'],
            'accent' => ['color' => '#f59e0b'],
            'neutral' => ['color' => '#64748b'],
            'success' => ['color' => '#16803c'],
            'warning' => ['color' => '#a85d00'],
            'danger' => ['color' => '#c52828'],
        ],
        'typography' => [
            'viewport' => ['minPx' => 360, 'maxPx' => 1440],
            'body' => ['minPx' => 16, 'maxPx' => 18],
            'scaleRatio' => 1.2,
            'headingScaleRatio' => 1.25,
            'bodyLineHeight' => 1.6,
            'headingLineHeight' => 1.15,
            'bodyFamily' => 'system-ui, sans-serif',
            'headingFamily' => 'system-ui, sans-serif',
        ],
        'spacing' => ['minPx' => 4, 'maxPx' => 6, 'scaleRatio' => 1.5, 'sectionMultiplier' => 8],
        'layout' => ['contentWidth' => 1200, 'textWidth' => 720, 'gutterMin' => 16, 'gutterMax' => 32],
        'shape' => ['radiusBase' => 8, 'borderWidth' => 1, 'shadowStrength' => 0.16],
        'motion' => ['durationFast' => 120, 'durationNormal' => 240, 'easingStandard' => 'cubic-bezier(0.2, 0, 0, 1)'],
    ];
}
