<?php

defined('ABSPATH') || exit;

function zeroy_runtime_table(string $name): string
{
    global $wpdb;
    return $wpdb->prefix . 'zeroy_runtime_' . $name;
}

function zeroy_runtime_error(string $code, string $message, int $status = 400, array $extra = []): WP_Error
{
    return new WP_Error($code, $message, ['status' => $status] + $extra);
}

function zeroy_runtime_json(mixed $value): string
{
    return (string) wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function zeroy_runtime_decode_json(string $json): array|WP_Error
{
    $decoded = json_decode($json, true);
    if (!is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
        return zeroy_runtime_error('zeroy_invalid_json', 'Expected a JSON object.', 400);
    }
    return $decoded;
}

/**
 * PHP associative decoding intentionally uses arrays, which collapses JSON {}
 * and [] into the same empty value.  zeroY treats that single empty value as
 * the neutral keyed map; populated lists remain rejected at every map boundary.
 */
function zeroy_runtime_is_keyed_map(mixed $value): bool
{
    return is_array($value) && ($value === [] || !array_is_list($value));
}

/**
 * PHP decodes both `{}` and `[]` into an empty array.  Internally that is a
 * useful neutral representation, but a wire field declared as a keyed map
 * must always serialize back to `{}`.  Keep that correction at the outward
 * projection boundary instead of weakening every consumer contract to accept
 * two meanings for an empty value.
 */
function zeroy_runtime_json_map(array $value): array|stdClass
{
    return $value === [] ? new stdClass() : $value;
}

function zeroy_runtime_sort_recursive(mixed $value): mixed
{
    if (!is_array($value)) {
        return $value;
    }

    foreach ($value as $key => $child) {
        $value[$key] = zeroy_runtime_sort_recursive($child);
    }
    if (!array_is_list($value)) {
        ksort($value, SORT_STRING);
    }
    return $value;
}

function zeroy_runtime_hash(mixed $value): string
{
    return hash('sha256', zeroy_runtime_json(zeroy_runtime_sort_recursive($value)));
}

function zeroy_runtime_site_id(): string
{
    $site_id = (string) get_option(ZEROY_RUNTIME_SITE_ID_OPTION, '');
    if ($site_id !== '') {
        return $site_id;
    }

    $site_id = wp_generate_uuid4();
    add_option(ZEROY_RUNTIME_SITE_ID_OPTION, $site_id, '', false);
    return $site_id;
}

function zeroy_runtime_connection_key(): string
{
    $key = (string) get_option(ZEROY_RUNTIME_CONNECTION_KEY_OPTION, '');
    if ($key !== '') {
        return $key;
    }

    $key = wp_generate_password(32, false, false);
    add_option(ZEROY_RUNTIME_CONNECTION_KEY_OPTION, $key, '', false);
    return $key;
}
