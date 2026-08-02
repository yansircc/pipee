<?php

defined('ABSPATH') || exit;

function zeroy_zcss_fluid_value(float $min, float $max, float $viewport_min, float $viewport_max, string $unit = 'rem'): string
{
    if ($viewport_min >= $viewport_max || $min <= 0 || $max < $min) throw new InvalidArgumentException('Invalid ZCSS fluid scale bounds.');
    $base = $unit === 'rem' ? 16.0 : 1.0;
    $min_value = $min / $base;
    $max_value = $max / $base;
    if (abs($max_value - $min_value) < 0.0000001) return zeroy_zcss_decimal($min_value) . $unit;
    $slope = ($max_value - $min_value) / ($viewport_max - $viewport_min) * 100;
    $intercept = $min_value - ($slope * $viewport_min / 100);
    return 'clamp(' . zeroy_zcss_decimal($min_value) . $unit . ', ' . zeroy_zcss_decimal($intercept) . $unit . ' + ' . zeroy_zcss_decimal($slope) . 'vw, ' . zeroy_zcss_decimal($max_value) . $unit . ')';
}

function zeroy_zcss_scale_tokens(array $design): array
{
    $typography = $design['typography'];
    $spacing = $design['spacing'];
    $layout = $design['layout'];
    $vmin = $typography['viewport']['minPx'];
    $vmax = $typography['viewport']['maxPx'];
    $tokens = [];
    foreach (array_combine(['xs', 's', 'm', 'l', 'xl', 'xxl'], [-2, -1, 0, 1, 2, 3]) as $name => $exponent) {
        $tokens['--z-text-' . $name] = zeroy_zcss_fluid_value($typography['body']['minPx'] * ($typography['scaleRatio'] ** $exponent), $typography['body']['maxPx'] * ($typography['scaleRatio'] ** $exponent), $vmin, $vmax);
        $tokens['--z-space-' . $name] = zeroy_zcss_fluid_value($spacing['minPx'] * ($spacing['scaleRatio'] ** ($exponent + 2)), $spacing['maxPx'] * ($spacing['scaleRatio'] ** ($exponent + 2)), $vmin, $vmax);
    }
    foreach ([1 => 6, 2 => 5, 3 => 4, 4 => 3, 5 => 2, 6 => 1] as $heading => $exponent) {
        $tokens['--z-heading-' . $heading] = zeroy_zcss_fluid_value($typography['body']['minPx'] * ($typography['headingScaleRatio'] ** $exponent), $typography['body']['maxPx'] * ($typography['headingScaleRatio'] ** $exponent), $vmin, $vmax);
    }
    $tokens['--z-section-space'] = zeroy_zcss_fluid_value($spacing['minPx'] * $spacing['sectionMultiplier'], $spacing['maxPx'] * $spacing['sectionMultiplier'], $vmin, $vmax);
    $tokens['--z-gutter'] = zeroy_zcss_fluid_value($layout['gutterMin'], $layout['gutterMax'], $vmin, $vmax);
    ksort($tokens, SORT_STRING);
    return $tokens;
}
