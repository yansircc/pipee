<?php

defined('ABSPATH') || exit;

function zeroy_zcss_srgb_to_linear(float $channel): float
{
    return $channel <= 0.04045 ? $channel / 12.92 : (($channel + 0.055) / 1.055) ** 2.4;
}

function zeroy_zcss_linear_to_srgb(float $channel): float
{
    return $channel <= 0.0031308 ? 12.92 * $channel : 1.055 * ($channel ** (1 / 2.4)) - 0.055;
}

function zeroy_zcss_hex_rgb(string $hex): array
{
    return [hexdec(substr($hex, 1, 2)) / 255, hexdec(substr($hex, 3, 2)) / 255, hexdec(substr($hex, 5, 2)) / 255];
}

function zeroy_zcss_rgb_hex(array $rgb): string
{
    $parts = array_map(static fn(float $channel): string => str_pad(dechex((int) round(max(0, min(1, $channel)) * 255)), 2, '0', STR_PAD_LEFT), $rgb);
    return '#' . implode('', $parts);
}

function zeroy_zcss_hex_to_oklch(string $hex): array
{
    [$r, $g, $b] = array_map('zeroy_zcss_srgb_to_linear', zeroy_zcss_hex_rgb($hex));
    $l = 0.4122214708 * $r + 0.5363325363 * $g + 0.0514459929 * $b;
    $m = 0.2119034982 * $r + 0.6806995451 * $g + 0.1073969566 * $b;
    $s = 0.0883024619 * $r + 0.2817188376 * $g + 0.6299787005 * $b;
    $l_ = $l ** (1 / 3);
    $m_ = $m ** (1 / 3);
    $s_ = $s ** (1 / 3);
    $L = 0.2104542553 * $l_ + 0.7936177850 * $m_ - 0.0040720468 * $s_;
    $a = 1.9779984951 * $l_ - 2.4285922050 * $m_ + 0.4505937099 * $s_;
    $bb = 0.0259040371 * $l_ + 0.7827717662 * $m_ - 0.8086757660 * $s_;
    return [$L, sqrt($a * $a + $bb * $bb), atan2($bb, $a)];
}

function zeroy_zcss_oklch_to_linear_rgb(float $L, float $C, float $h): array
{
    $a = $C * cos($h);
    $b = $C * sin($h);
    $l_ = $L + 0.3963377774 * $a + 0.2158037573 * $b;
    $m_ = $L - 0.1055613458 * $a - 0.0638541728 * $b;
    $s_ = $L - 0.0894841775 * $a - 1.2914855480 * $b;
    $l = $l_ ** 3;
    $m = $m_ ** 3;
    $s = $s_ ** 3;
    return [
        4.0767416621 * $l - 3.3077115913 * $m + 0.2309699292 * $s,
        -1.2684380046 * $l + 2.6097574011 * $m - 0.3413193965 * $s,
        -0.0041960863 * $l - 0.7034186147 * $m + 1.7076147010 * $s,
    ];
}

function zeroy_zcss_oklch_hex(float $L, float $C, float $h): string
{
    $L = max(0, min(1, $L));
    $candidate = zeroy_zcss_oklch_to_linear_rgb($L, $C, $h);
    $in_gamut = static fn(array $rgb): bool => min($rgb) >= -0.0000001 && max($rgb) <= 1.0000001;
    if (!$in_gamut($candidate)) {
        $low = 0.0;
        $high = max(0.0, $C);
        for ($iteration = 0; $iteration < 24; $iteration++) {
            $mid = ($low + $high) / 2;
            $probe = zeroy_zcss_oklch_to_linear_rgb($L, $mid, $h);
            if ($in_gamut($probe)) {
                $low = $mid;
                $candidate = $probe;
            } else $high = $mid;
        }
    }
    return zeroy_zcss_rgb_hex(array_map('zeroy_zcss_linear_to_srgb', $candidate));
}

function zeroy_zcss_luminance(string $hex): float
{
    [$r, $g, $b] = array_map('zeroy_zcss_srgb_to_linear', zeroy_zcss_hex_rgb($hex));
    return 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
}

function zeroy_zcss_contrast(string $left, string $right): float
{
    $a = zeroy_zcss_luminance($left);
    $b = zeroy_zcss_luminance($right);
    return (max($a, $b) + 0.05) / (min($a, $b) + 0.05);
}

function zeroy_zcss_on_color(string $background, float $threshold = 4.5): array
{
    $black = zeroy_zcss_contrast($background, '#000000');
    $white = zeroy_zcss_contrast($background, '#ffffff');
    $color = $black >= $white ? '#000000' : '#ffffff';
    $ratio = max($black, $white);
    return $ratio >= $threshold
        ? ['ok' => true, 'color' => $color, 'contrast' => $ratio]
        : ['ok' => false, 'diagnostic' => zeroy_zcss_diagnostic('zcss_contrast_invalid', '/palette', $background, 'Foreground contrast must be at least ' . $threshold . ':1.', 'Choose a palette color that supports readable black or white text.')];
}

function zeroy_zcss_palette_tokens(array $palette): array
{
    $tokens = [];
    $diagnostics = [];
    foreach ($palette as $name => $entry) {
        $base = $entry['color'];
        [$L, $C, $h] = zeroy_zcss_hex_to_oklch($base);
        foreach ([50 => [0.97, 0.18], 100 => [0.93, 0.30], 200 => [0.85, 0.48], 300 => [0.75, 0.68], 400 => [0.65, 0.86], 500 => [$L, 1.0], 600 => [max(0.18, $L - 0.10), 0.96], 700 => [max(0.14, $L - 0.20), 0.90], 800 => [max(0.10, $L - 0.30), 0.82], 900 => [max(0.06, $L - 0.40), 0.70]] as $shade => [$lightness, $chroma]) {
            $tokens['--z-color-' . $name . '-' . $shade] = zeroy_zcss_oklch_hex($lightness, $C * $chroma, $h);
        }
        $tokens['--z-color-' . $name] = $base;
        $on = zeroy_zcss_on_color($base);
        if (!$on['ok']) $diagnostics[] = $on['diagnostic'];
        else $tokens['--z-color-on-' . $name] = $on['color'];
    }
    $surface = '#ffffff';
    $on_surface = '#111827';
    $tokens += [
        '--z-color-surface' => $surface,
        '--z-color-on-surface' => $on_surface,
        '--z-color-surface-muted' => $tokens['--z-color-neutral-50'],
        '--z-color-border' => $tokens['--z-color-neutral-200'],
        '--z-color-action' => $tokens['--z-color-brand'],
        '--z-color-on-action' => $tokens['--z-color-on-brand'],
        '--z-color-action-hover' => $tokens['--z-color-brand-600'],
        '--z-color-focus' => $tokens['--z-color-accent'],
        '--z-color-status-success' => $tokens['--z-color-success'],
        '--z-color-on-status-success' => $tokens['--z-color-on-success'],
        '--z-color-status-warning' => $tokens['--z-color-warning'],
        '--z-color-on-status-warning' => $tokens['--z-color-on-warning'],
        '--z-color-status-danger' => $tokens['--z-color-danger'],
        '--z-color-on-status-danger' => $tokens['--z-color-on-danger'],
    ];
    ksort($tokens, SORT_STRING);
    return $diagnostics === [] ? ['ok' => true, 'tokens' => $tokens] : ['ok' => false, 'diagnostics' => $diagnostics];
}
