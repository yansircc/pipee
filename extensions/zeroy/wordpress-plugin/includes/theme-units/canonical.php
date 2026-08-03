<?php

defined('ABSPATH') || exit;

function zeroy_theme_units_canonical_value(mixed $value): mixed
{
    if (!is_array($value)) return $value;
    if (array_is_list($value)) return array_map('zeroy_theme_units_canonical_value', $value);
    ksort($value, SORT_STRING);
    foreach ($value as $key => $child) $value[$key] = zeroy_theme_units_canonical_value($child);
    return $value;
}

function zeroy_theme_units_canonical_json(mixed $value): string
{
    return json_encode(zeroy_theme_units_canonical_value($value), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
}

function zeroy_theme_units_hash(mixed $value): string
{
    return hash('sha256', zeroy_theme_units_canonical_json($value));
}
