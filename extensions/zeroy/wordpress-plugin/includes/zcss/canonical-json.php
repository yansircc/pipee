<?php

defined('ABSPATH') || exit;

function zeroy_zcss_canonical_value(mixed $value): mixed
{
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
