<?php

defined('ABSPATH') || exit;

/**
 * Canonical JSON is the compiler's input identity boundary.  Key ordering
 * alone is insufficient: the same visible font family can otherwise arrive
 * as decomposed Unicode or with platform-specific line endings and produce a
 * different DesignDocument hash.
 *
 * ASCII values do not require an optional PHP extension.  A non-ASCII value
 * requires ext-intl so the compiler either emits NFC bytes everywhere or
 * rejects the input; it never silently makes host-dependent bytes.
 */
function zeroy_zcss_canonical_string(string $value): string
{
    $value = str_replace(["\r\n", "\r"], "\n", $value);
    if (preg_match('/[^\x00-\x7f]/', $value) !== 1) return $value;
    if (!class_exists('Normalizer')) {
        throw new LogicException('ZCSS requires ext-intl to normalize non-ASCII DesignDocument strings.');
    }
    $normalized = Normalizer::normalize($value, Normalizer::FORM_C);
    if (!is_string($normalized)) throw new LogicException('ZCSS could not normalize a DesignDocument string as Unicode NFC.');
    return $normalized;
}

function zeroy_zcss_canonical_value(mixed $value): mixed
{
    if (is_string($value)) return zeroy_zcss_canonical_string($value);
    if (!is_array($value)) return $value;
    if (array_is_list($value)) return array_map('zeroy_zcss_canonical_value', $value);
    ksort($value, SORT_STRING);
    foreach ($value as $key => $child) $value[$key] = zeroy_zcss_canonical_value($child);
    return $value;
}

function zeroy_zcss_canonical_json(mixed $value): string
{
    return json_encode(
        zeroy_zcss_canonical_value($value),
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR,
    ) . "\n";
}

function zeroy_zcss_hash(mixed $value): string
{
    return hash('sha256', zeroy_zcss_canonical_json($value));
}

function zeroy_zcss_decimal(float|int $value, int $precision = 6): string
{
    if (!is_finite((float) $value)) throw new InvalidArgumentException('ZCSS cannot serialize a non-finite number.');
    $formatted = number_format((float) $value, $precision, '.', '');
    $formatted = rtrim(rtrim($formatted, '0'), '.');
    return $formatted === '-0' || $formatted === '' ? '0' : $formatted;
}
