<?php

defined('ABSPATH') || exit;

function zeroy_zcss_compile_tokens(array $design): array
{
    $palette = zeroy_zcss_palette_tokens($design['palette']);
    if (!$palette['ok']) return $palette;
    $tokens = $palette['tokens'] + zeroy_zcss_scale_tokens($design);
    $tokens += [
        '--z-font-body' => $design['typography']['bodyFamily'],
        '--z-font-heading' => $design['typography']['headingFamily'],
        '--z-line-body' => zeroy_zcss_decimal($design['typography']['bodyLineHeight']),
        '--z-line-heading' => zeroy_zcss_decimal($design['typography']['headingLineHeight']),
        '--z-content-width' => zeroy_zcss_decimal($design['layout']['contentWidth'] / 16) . 'rem',
        '--z-text-width' => zeroy_zcss_decimal($design['layout']['textWidth'] / 16) . 'rem',
        '--z-radius' => zeroy_zcss_decimal($design['shape']['radiusBase'] / 16) . 'rem',
        '--z-border-width' => zeroy_zcss_decimal($design['shape']['borderWidth']) . 'px',
        '--z-shadow' => '0 0.5rem 1.5rem rgb(15 23 42 / ' . zeroy_zcss_decimal($design['shape']['shadowStrength']) . ')',
        '--z-duration-fast' => zeroy_zcss_decimal($design['motion']['durationFast']) . 'ms',
        '--z-duration-normal' => zeroy_zcss_decimal($design['motion']['durationNormal']) . 'ms',
        '--z-easing-standard' => $design['motion']['easingStandard'],
    ];
    ksort($tokens, SORT_STRING);
    $projection = [];
    foreach ($tokens as $name => $value) {
        $category = str_starts_with($name, '--z-color-') ? 'color' : (str_starts_with($name, '--z-text-') || str_starts_with($name, '--z-heading-') || str_starts_with($name, '--z-font-') || str_starts_with($name, '--z-line-') ? 'typography' : (str_starts_with($name, '--z-space-') || $name === '--z-section-space' || $name === '--z-gutter' ? 'spacing' : 'foundation'));
        $projection[] = ['name' => $name, 'category' => $category, 'value' => $value];
    }
    return ['ok' => true, 'map' => $tokens, 'tokens' => $projection];
}
