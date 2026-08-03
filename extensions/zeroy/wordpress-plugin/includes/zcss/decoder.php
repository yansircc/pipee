<?php

defined('ABSPATH') || exit;

function zeroy_zcss_diagnostic(string $code, string $path, mixed $value, string $constraint, string $repair): array
{
    return ['code' => $code, 'path' => $path, 'value' => $value, 'constraint' => $constraint, 'repair' => $repair];
}

function zeroy_zcss_font_family_valid(string $value): bool
{
    if (preg_match('/\A[\p{L}\p{M}\p{N}\s,.\'"_+-]+\z/u', $value) !== 1) return false;
    foreach (explode(',', $value) as $family) {
        $family = trim($family);
        if ($family === '') return false;
        $quote = $family[0] ?? '';
        if (($quote === '"' || $quote === "'") && (strlen($family) < 2 || !str_ends_with($family, $quote))) return false;
    }
    return true;
}

function zeroy_zcss_decode_spec(array $spec, mixed $value, string $path, array &$errors): mixed
{
    if ($spec['kind'] === 'object') {
        $keys = array_keys($spec['properties']);
        if (!is_array($value) || array_is_list($value)) {
            $errors[] = zeroy_zcss_diagnostic('zcss_object_required', $path, $value, 'Must be an object with exactly: ' . implode(', ', $keys) . '.', 'Provide every declared field and no unknown fields.');
            return null;
        }
        $actual = array_keys($value);
        $sorted_actual = $actual;
        $sorted_expected = $keys;
        sort($sorted_actual, SORT_STRING);
        sort($sorted_expected, SORT_STRING);
        if ($sorted_actual !== $sorted_expected) {
            $errors[] = zeroy_zcss_diagnostic('zcss_keys_invalid', $path, $sorted_actual, 'Keys must be exactly: ' . implode(', ', $sorted_expected) . '.', 'Add missing keys and remove unknown keys.');
            return null;
        }
        $decoded = [];
        foreach ($spec['properties'] as $key => $child) $decoded[$key] = zeroy_zcss_decode_spec($child, $value[$key], $path . '/' . $key, $errors);
        return $decoded;
    }
    if ($spec['kind'] === 'literal') {
        if ($value !== $spec['value']) {
            $errors[] = zeroy_zcss_diagnostic('zcss_contract_invalid', $path, $value, 'Must equal ' . $spec['value'] . '.', 'Use the current ZCSS design contract.');
            return null;
        }
        return $value;
    }
    if ($spec['kind'] === 'number') {
        if ((!is_int($value) && !is_float($value)) || !is_finite((float) $value) || $value < $spec['minimum'] || $value > $spec['maximum']) {
            $errors[] = zeroy_zcss_diagnostic('zcss_number_invalid', $path, $value, 'Must be a finite number from ' . $spec['minimum'] . ' through ' . $spec['maximum'] . '.', 'Choose a value inside the declared range.');
            return null;
        }
        return (float) $value;
    }
    if ($spec['kind'] === 'color') {
        if (!is_string($value) || preg_match('/\A#[0-9a-fA-F]{6}\z/', $value) !== 1) {
            $errors[] = zeroy_zcss_diagnostic('zcss_color_invalid', $path, $value, 'Must be a six-digit sRGB hexadecimal color.', 'Use a value such as #1f5eff.');
            return null;
        }
        return strtolower($value);
    }
    if ($spec['kind'] === 'font-family') {
        if (!is_string($value) || trim($value) === '' || strlen($value) > $spec['maxLength'] || !zeroy_zcss_font_family_valid($value)) {
            $errors[] = zeroy_zcss_diagnostic('zcss_font_family_invalid', $path, $value, 'Must be a non-empty comma-separated CSS font-family declaration with complete optional quotes and no URL, comment, or rule syntax.', 'Provide only local or system font family names; load no network resource.');
            return null;
        }
        return trim($value);
    }
    if ($spec['kind'] === 'easing') {
        if (!is_string($value) || preg_match('/\A(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\((-?[0-9.]+),\s*(-?[0-9.]+),\s*(-?[0-9.]+),\s*(-?[0-9.]+)\))\z/', $value) !== 1) {
            $errors[] = zeroy_zcss_diagnostic('zcss_easing_invalid', $path, $value, 'Must be a CSS easing keyword or cubic-bezier() value.', 'Use a deterministic easing value such as cubic-bezier(0.2, 0, 0, 1).');
            return null;
        }
        return preg_replace('/\s+/', ' ', $value);
    }
    throw new LogicException('Unknown ZCSS DesignSpec kind.');
}

function zeroy_zcss_decode_design(mixed $input): array
{
    $errors = [];
    $design = zeroy_zcss_decode_spec(zeroy_zcss_design_spec(), $input, '', $errors);
    if (is_array($design)) {
        foreach ([
            ['/typography/viewport', $design['typography']['viewport']['minPx'], $design['typography']['viewport']['maxPx'], 'minPx must be less than maxPx.'],
            ['/typography/body', $design['typography']['body']['minPx'], $design['typography']['body']['maxPx'], 'minPx must not exceed maxPx.'],
            ['/spacing', $design['spacing']['minPx'], $design['spacing']['maxPx'], 'minPx must not exceed maxPx.'],
            ['/layout', $design['layout']['gutterMin'], $design['layout']['gutterMax'], 'gutterMin must not exceed gutterMax.'],
            ['/motion', $design['motion']['durationFast'], $design['motion']['durationNormal'], 'durationFast must not exceed durationNormal.'],
        ] as [$path, $minimum, $maximum, $constraint]) {
            if ($minimum > $maximum || ($path === '/typography/viewport' && $minimum === $maximum)) $errors[] = zeroy_zcss_diagnostic('zcss_range_invalid', $path, ['minimum' => $minimum, 'maximum' => $maximum], $constraint, 'Correct the related minimum and maximum values.');
        }
        if ($design['layout']['textWidth'] > $design['layout']['contentWidth']) $errors[] = zeroy_zcss_diagnostic('zcss_range_invalid', '/layout/textWidth', $design['layout']['textWidth'], 'textWidth must not exceed contentWidth.', 'Use a readable text width inside the content width.');
    }
    if ($errors !== [] || !is_array($design)) return ['ok' => false, 'diagnostics' => $errors];
    try {
        return ['ok' => true, 'design' => zeroy_zcss_canonical_value($design)];
    } catch (LogicException $error) {
        return ['ok' => false, 'diagnostics' => [zeroy_zcss_diagnostic('zcss_unicode_normalization_unavailable', '/', null, $error->getMessage(), 'Install PHP ext-intl or use ASCII-only DesignDocument strings.')]];
    }
}
